// Type-only import: erased at build time.
// OpenCode V2's plugin loader cannot resolve bare static imports from the
// plugin directory, so the plugin is exported as a plain definition object.
import type { Plugin } from "@opencode/plugin";
import { initDatabase, isDatabaseEmpty, seedGoldenRules, seedHeuristics, getDbClient, backfillFTS } from "./db/client.js";
import { embeddingService } from "./services/embeddings.js";
import { QueryService } from "./services/query.js";
import { metricsService } from "./services/metrics.js";
import { createHash } from "node:crypto";
import { getDbPaths, GLOBAL_DB_PATH } from "./config.js";

interface ElfToolArgs {
  mode?: string;
  content?: string;
  pattern?: string;
  suggestion?: string;
  query?: string;
  limit?: number;
  scope?: "global" | "project";
}

/** Text of the most recent user message in a model request. */
function latestUserText(messages: ReadonlyArray<{ role: string; content: ReadonlyArray<{ type: string; text?: unknown }> }>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}

/** Flatten a v2 tool result into plain text. */
function resultText(result: { content?: string | ReadonlyArray<unknown>; output?: unknown } | undefined): string {
  if (!result) return "";
  if (typeof result.content === "string") return result.content;
  if (Array.isArray(result.content)) {
    return result.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("\n");
  }
  if (typeof result.output === "string") return result.output;
  if (result.output !== undefined) return JSON.stringify(result.output);
  return "";
}

/** Command text from tool input, for embeddings and success heuristics. */
function commandContext(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  if (typeof args.command === "string") return args.command;
  if (typeof args.cmd === "string") return args.cmd;
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

/**
 * OpenCode ELF Plugin (OpenCode V2 plugin API)
 *
 * Emergent Learning Framework - Learns from past successes and failures
 */
const elfPlugin: Plugin.Plugin = {
  id: "elf",

  async setup(ctx) {
    const directory = ctx.location.directory;

    // Create query service with working directory
    const queryService = new QueryService(directory);

    // Track initialization state
    let initError: Error | null = null;

    // Track the most recently injected learning IDs to provide feedback
    let lastInjectedLearningIds: string[] = [];

    // 1. Start initialization in the background (do not await here)
    const initPromise = (async () => {
      console.log("ELF: Initializing in background...");
      const start = Date.now();

      try {
        // Get database paths
        const paths = getDbPaths(directory);

        // Initialize global database (always)
        await initDatabase(GLOBAL_DB_PATH);

        // Initialize project database if available
        if (paths.project) {
          await initDatabase(paths.project);
        }

        // Pre-load embedding model (This is the heavy part)
        await embeddingService.init();

        // Check if global database is empty and seed if needed
        const isEmpty = await isDatabaseEmpty(GLOBAL_DB_PATH);
        if (isEmpty) {
          console.log("ELF: First run detected - seeding default data...");
          await seedGoldenRules(queryService.addGoldenRule.bind(queryService));
          await seedHeuristics(GLOBAL_DB_PATH);
        }

        // Backfill FTS table for existing learnings (runs once after FTS is added)
        await backfillFTS(GLOBAL_DB_PATH);
        if (paths.project) {
          await backfillFTS(paths.project);
        }

        console.log(`ELF: Ready (took ${Date.now() - start}ms)`);
      } catch (error) {
        console.error("ELF: Background initialization failed", error);
        initError = error instanceof Error ? error : new Error(String(error));
        throw error;
      }
    })();

    // 2. Helper to ensure we are ready before processing hooks
    const ensureReady = async () => {
      if (initError) throw initError;
      await initPromise;
    };

    // 3. Penalize learnings that were injected when a failure happened
    const penalizeInjected = async () => {
      if (lastInjectedLearningIds.length === 0) return;
      for (const id of lastInjectedLearningIds) {
        await queryService.updateLearningUtility(id, -0.1);
      }
      console.log(`ELF: Penalized ${lastInjectedLearningIds.length} learnings due to failure`);
      lastInjectedLearningIds = [];
    };

    // 4. Boost learnings that were injected when a success happened
    const boostInjected = async () => {
      if (lastInjectedLearningIds.length === 0) return;
      for (const id of lastInjectedLearningIds) {
        await queryService.updateLearningUtility(id, 0.1);
      }
      console.log(`ELF: Boosted ${lastInjectedLearningIds.length} learnings due to success`);
      lastInjectedLearningIds = [];
    };

    // 5. Record a failure learning with its command context
    const recordFailure = async (
      toolName: string,
      args: Record<string, unknown> | undefined,
      errorDetail: string,
      fullContext: string
    ) => {
      let context = commandContext(args);
      if (context.length > 100) {
        context = `${context.substring(0, 97)}...`;
      }

      const learningContent = `Tool '${toolName}' failed${context ? ` running '${context}'` : ''}: ${errorDetail}`;

      await queryService.recordLearning(learningContent, 'failure', fullContext);
      metricsService.record('learning_failure', 1, { tool: toolName });
      console.log(`ELF: Recorded failure - ${learningContent.slice(0, 50)}...`);
      await penalizeInjected();
    };

    /**
     * Context hook - Inject ELF context into the system prompt before the model call
     */
    await ctx.session.hook("context", async (event) => {
      const start = Date.now();

      try {
        // Wait for init to finish (only affects the very first message)
        await ensureReady();

        const userMessage = latestUserText(event.messages);
        if (!userMessage) return;

        // Get relevant context from ELF
        const context = await queryService.getContext(userMessage);

        // Track which items were injected for feedback loop
        lastInjectedLearningIds = context.relevantLearnings.map(r => r.item.id);

        // Track which golden rules we're using
        if (context.goldenRules.length > 0) {
          const ruleIds = context.goldenRules.map((r: { id: string }) => r.id);
          await queryService.incrementGoldenRuleHits(ruleIds);
        }

        // Only inject if we have meaningful context
        if (context.goldenRules.length > 0 ||
          context.relevantLearnings.length > 0 ||
          context.heuristics.length > 0) {

          const elfMemory = queryService.formatContextForPrompt(context);
          event.system.push({ type: "text", text: elfMemory });

          // Record metrics
          const duration = Date.now() - start;
          metricsService.record('latency', duration);
          metricsService.record('injection', 1, {
            rules: context.goldenRules.length,
            learnings: context.relevantLearnings.length,
            heuristics: context.heuristics.length
          });
        }
      } catch (error) {
        // Fail open: If ELF fails, log it but don't break the user's chat
        console.error("ELF: Error in context hook", error);
      }
    });

    /**
     * Tool hook - Learn from tool executions
     */
    await ctx.tool.hook("execute.after", async (event) => {
      try {
        // We can process events even if init is still running,
        // but we need the DB ready to record learnings.
        await ensureReady();

        const toolName = event.tool;
        if (!toolName) return;

        const args = (event.input ?? undefined) as Record<string, unknown> | undefined;

        if (event.status === "error") {
          // V2 reports hard failures (permission denied, thrown errors) as status "error"
          const errorDetail = event.error?.message || "Tool error";
          await recordFailure(toolName, args, errorDetail, JSON.stringify({ args, error: errorDetail }));
          return;
        }

        // Completed result: the V2 shell tool reports the exit code in
        // result.metadata.exit and appends "Exited with code N" to the text.
        const result = event.result as {
          content?: string | ReadonlyArray<unknown>;
          output?: { exit?: number; status?: string };
          metadata?: { exit?: number; status?: string };
        } | undefined;

        const outputText = resultText(result);
        const exitCode = typeof result?.metadata?.exit === "number"
          ? result.metadata.exit
          : typeof result?.output?.exit === "number"
            ? result.output.exit
            : undefined;
        const resultStatus = result?.metadata?.status ?? result?.output?.status;

        // Ignore user interruptions (SIGINT/130) and aborted commands.
        if (exitCode === 130) return;
        const aborted = resultStatus === "aborted" ||
          outputText.includes("aborted before completion") ||
          outputText.includes("Command was aborted");

        const failed = !aborted && (
          (exitCode !== undefined && exitCode !== 0) ||
          /Exited with code [1-9]/.test(outputText)
        );

        if (failed) {
          const errorDetail = exitCode !== undefined ? `Exited with code ${exitCode}` : outputText.slice(-200);
          await recordFailure(
            toolName,
            args,
            errorDetail,
            JSON.stringify({ args, result: outputText.slice(0, 2000) })
          );
          return;
        }

        // Success recording and utility boosting
        const context = commandContext(args);

        const isComplex = context.length > 20 ||
          ['build', 'compile', 'deploy', 'test', 'git', 'docker', 'npm', 'yarn', 'pnpm', 'npx'].some(k =>
            context.toLowerCase().includes(k)
          );

        if (isComplex) {
          const learningContent = `Tool '${toolName}' succeeded running '${context.length > 100 ? context.substring(0, 97) + '...' : context}'`;
          const fullContext = JSON.stringify({ args, result: outputText.slice(0, 2000) });

          await queryService.recordLearning(learningContent, 'success', fullContext);
          console.log(`ELF: Recorded success - ${learningContent.slice(0, 50)}...`);
        }

        await boostInjected();
      } catch (error) {
        console.error("ELF: Error in tool hook", error);
      }
    });

    /**
     * Run an `elf` tool command. Returns the JSON payload as text.
     */
    const runElfCommand = async (args: ElfToolArgs): Promise<string> => {
      const paths = getDbPaths(directory);

      let mode = args.mode || "help";

      // Helper to normalize "rules list" -> "rules-list" if the LLM passes it with space
      if (mode.includes(" ")) {
        mode = mode.replace(" ", "-");
      }

      try {
        switch (mode) {
          case "help": {
            return JSON.stringify({
              success: true,
              message: "ELF (Emergent Learning Framework) Usage Guide",
              commands: [
                { command: "rules list", description: "List golden rules" },
                { command: "heuristics list", description: "List heuristics" },
                { command: "learnings list", description: "List recent learnings" },
                { command: "rules add", description: "Add a golden rule", args: ["content"] },
                { command: "heuristics add", description: "Add a heuristic", args: ["pattern", "suggestion"] },
                { command: "metrics", description: "View performance metrics" },
                { command: "search", description: "Search learnings", args: ["query"] }
              ]
            });
          }

          case "rules-list": {
            const scope = args.scope;
            const clients = scope === "global"
              ? [getDbClient(GLOBAL_DB_PATH)]
              : scope === "project" && paths.project
                ? [getDbClient(paths.project)]
                : [getDbClient(GLOBAL_DB_PATH), ...(paths.project ? [getDbClient(paths.project)] : [])];

            const allRules: Array<{ id: string; content: string; hitCount: number; created: string; scope: string }> = [];

            for (let i = 0; i < clients.length; i++) {
              const db = clients[i];
              const dbScope = (scope || (i === 0 ? "global" : "project")) as string;

              const result = await db.execute(
                "SELECT id, content, hit_count, created_at FROM golden_rules ORDER BY hit_count DESC"
              );

              allRules.push(...result.rows.map(r => ({
                id: r.id as string,
                content: r.content as string,
                hitCount: r.hit_count as number,
                created: new Date(r.created_at as number).toISOString(),
                scope: dbScope,
              })));
            }

            return JSON.stringify({
              success: true,
              rules: allRules,
              count: allRules.length,
            });
          }

          case "heuristics-list": {
            const scope = args.scope;
            const clients = scope === "global"
              ? [getDbClient(GLOBAL_DB_PATH)]
              : scope === "project" && paths.project
                ? [getDbClient(paths.project)]
                : [getDbClient(GLOBAL_DB_PATH), ...(paths.project ? [getDbClient(paths.project)] : [])];

            const allHeuristics: Array<{ id: string; pattern: string; suggestion: string; created: string; scope: string }> = [];

            for (let i = 0; i < clients.length; i++) {
              const db = clients[i];
              const dbScope = (scope || (i === 0 ? "global" : "project")) as string;

              const result = await db.execute(
                "SELECT id, pattern, suggestion, created_at FROM heuristics ORDER BY created_at DESC"
              );

              allHeuristics.push(...result.rows.map(r => ({
                id: r.id as string,
                pattern: r.pattern as string,
                suggestion: r.suggestion as string,
                created: new Date(r.created_at as number).toISOString(),
                scope: dbScope,
              })));
            }

            return JSON.stringify({
              success: true,
              heuristics: allHeuristics,
              count: allHeuristics.length,
            });
          }

          case "learnings-list": {
            const limit = args.limit || 20;
            const scope = args.scope;
            const clients = scope === "global"
              ? [getDbClient(GLOBAL_DB_PATH)]
              : scope === "project" && paths.project
                ? [getDbClient(paths.project)]
                : [getDbClient(GLOBAL_DB_PATH), ...(paths.project ? [getDbClient(paths.project)] : [])];

            const allLearnings: Array<{ id: string; category: string; content: string; created: string; scope: string }> = [];

            for (let i = 0; i < clients.length; i++) {
              const db = clients[i];
              const dbScope = (scope || (i === 0 ? "global" : "project")) as string;

              const result = await db.execute({
                sql: "SELECT id, category, content, created_at FROM learnings ORDER BY created_at DESC LIMIT ?",
                args: [limit],
              });

              allLearnings.push(...result.rows.map(r => ({
                id: r.id as string,
                category: r.category as string,
                content: r.content as string,
                created: new Date(r.created_at as number).toISOString(),
                scope: dbScope,
              })));
            }

            // Sort all learnings by creation date
            allLearnings.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

            return JSON.stringify({
              success: true,
              learnings: allLearnings.slice(0, limit),
              count: allLearnings.length,
            });
          }

          case "rules-add": {
            if (!args.content) {
              return JSON.stringify({
                success: false,
                error: "content parameter is required for rules-add mode",
              });
            }

            const scope = args.scope || "global";
            await queryService.addGoldenRule(args.content, scope);

            return JSON.stringify({
              success: true,
              message: `Golden rule added successfully to ${scope} scope`,
              content: args.content,
              scope,
            });
          }

          case "heuristics-add": {
            if (!args.pattern || !args.suggestion) {
              return JSON.stringify({
                success: false,
                error: "pattern and suggestion parameters are required for heuristics-add mode",
              });
            }

            const scope = args.scope || "global";
            const dbPath = scope === "project" && paths.project ? paths.project : GLOBAL_DB_PATH;
            const db = getDbClient(dbPath);

            const id = createHash('sha256')
              .update(args.pattern + args.suggestion)
              .digest('hex')
              .slice(0, 16);

            await db.execute({
              sql: `INSERT OR IGNORE INTO heuristics (id, pattern, suggestion, created_at)
                  VALUES (?, ?, ?, ?)`,
              args: [id, args.pattern, args.suggestion, Date.now()]
            });

            return JSON.stringify({
              success: true,
              message: `Heuristic added successfully to ${scope} scope`,
              pattern: args.pattern,
              suggestion: args.suggestion,
              scope,
            });
          }

          case "metrics": {
            const db = getDbClient(GLOBAL_DB_PATH);
            const result = await db.execute(
              "SELECT type, COUNT(*) as count, AVG(value) as avg_value, MIN(value) as min_value, MAX(value) as max_value FROM metrics GROUP BY type ORDER BY type"
            );
            return JSON.stringify({
              success: true,
              metrics: result.rows.map(r => ({
                type: r.type,
                count: r.count,
                average: r.avg_value,
                min: r.min_value,
                max: r.max_value,
              })),
            });
          }

          case "search": {
            if (!args.query) {
              return JSON.stringify({
                success: false,
                error: "query parameter is required for search mode",
              });
            }

            const results = await queryService.searchHybrid(args.query);
            const limit = args.limit || 10;

            return JSON.stringify({
              success: true,
              query: args.query,
              count: results.length,
              results: results.slice(0, limit).map(r => ({
                id: r.item.id,
                content: r.item.content,
                category: r.item.category,
                score: Number.parseFloat(r.score.toFixed(3)),
                matchType: r.item.matchType || 'semantic',
                scope: r.item.scope || 'global',
                created: new Date(r.item.created_at).toISOString(),
              })),
            });
          }

          default:
            return JSON.stringify({
              success: false,
              error: `Unknown mode: ${mode}`,
            });
        }
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    /**
     * ELF tool for agent use
     */
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "elf",
        description: "Manage and query the ELF (Emergent Learning Framework) memory system. Use 'search' mode for hybrid semantic+keyword search across all learnings. If no mode is specified, returns help.",
        input: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: [
                "rules-list",
                "rules-add",
                "heuristics-list",
                "heuristics-add",
                "learnings-list",
                "metrics",
                "search",
                "help"
              ]
            },
            content: { type: "string" },
            pattern: { type: "string" },
            suggestion: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" },
            scope: { type: "string", enum: ["global", "project"] },
          },
          additionalProperties: false,
        },
        async execute(input) {
          // Tool execution MUST wait for initialization
          await ensureReady();
          const args = (input ?? {}) as ElfToolArgs;
          return { content: await runElfCommand(args) };
        },
      });
    });
  },
};

export default elfPlugin;
