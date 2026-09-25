# OpenCode ELF Plugin

**[Emergent Learning Framework (ELF)](https://github.com/Spacehunterz/Emergent-Learning-Framework_ELF)** for OpenCode - Learn from past successes and failures to continuously improve your AI coding assistant.

## Overview

- **Golden Rules**: Constitutional principles that guide all actions  
- **Heuristics**: Pattern-based suggestions triggered by keywords/regex  
- **Learnings**: Automatic recording of tool execution failures and successes  
- **Confidence & Utility**: Feedback loop that boosts or penalizes memories based on success  
- **Emergence Loop**: Memory consolidation promotes repeated patterns to Golden Rules
- **Context Injection**: Relevant past experiences are injected into each conversation  
- **Hybrid Storage**: Support for both global and project-scoped memories  
- **Hybrid Search**: Combined vector (semantic) + FTS5 (keyword) search for best results
- **Privacy Controls**: Use `<private>` tags to exclude sensitive data from storage
- **Automatic Cleanup**: Configurable expiration for unused rules and old learnings
- **Local-First**: Uses local SQLite storage and local embeddings (no API calls)

## Key Features

### Hybrid Storage

ELF supports both **global** and **project-scoped** memories:

- **Global memories**: Shared across all projects (stored in `~/.opencode/elf/memory.db`)
- **Project memories**: Specific to each project (stored in `<project>/.opencode/elf/memory.db`)
- Project detection via `.git` or `.opencode` directories
- Project memories are prioritized in context injection
- Add project memories to `.gitignore` for privacy, or commit for team sharing

**Example usage:**
```
"Add a global rule: Always validate user inputs"
"Add a project rule: This API requires JWT authentication"
```

**Context injection shows both, with project memories tagged:**
```
Golden Rules:
- Always validate user inputs
- This API requires JWT authentication [project]
```

### Performance Optimizations

- **Lazy Loading**: Non-blocking plugin initialization - OpenCode starts instantly
- **Parallel Database Queries**: Global + project databases queried simultaneously (30-50% faster)
- **Embedding Cache**: LRU cache with 5-minute TTL reduces embedding generation by 60-70% on repeated queries
- **Efficient Context Retrieval**: Optimized vector similarity search with intelligent caching

### Local-First Architecture

- Uses local SQLite storage (no cloud dependencies)
- Local embeddings with @xenova/transformers (no API calls)
- All data stays on your machine
- Works offline after initial model download (~90MB)
- Automatic cleanup prevents database from growing indefinitely

### Hybrid Search (Vector + FTS)

ELF now supports **hybrid search** combining semantic vector search with SQLite FTS5 full-text search:

- **Vector Search**: Great for *concepts* ("how do I fix a database lock?")
- **FTS Search**: Superior for *specifics* ("error code 503", "function processData")
- **Hybrid**: Combines both approaches for best results

Results include a `matchType` indicator:
- `semantic` - Found via vector similarity
- `keyword` - Found via FTS keyword match
- `hybrid` - Found by both (boosted score)

**Example usage via the elf tool:**
```
"Search my learnings for error code ENOENT"
"Find learnings about authentication failures"
```

### Privacy Controls

Protect sensitive data using `<private>` tags:

```
The API key is <private>sk-abc123xyz</private>
```

**How it works:**
- Content wrapped in `<private>...</private>` tags is never stored
- If the entire content contains privacy tags, the learning is skipped
- Partial private content is replaced with `[REDACTED]`
- Works for both `content` and `context` in learnings

## Installation

### Requirements

- OpenCode V2 (plugin API `@opencode/plugin` 2.x)
- Node.js 22+ for the optional CLI scripts (`node:sqlite`). OpenCode itself provides its own runtime for the plugin.

### Option 1: Local tarball (recommended for this fork)

Build and pack the plugin:

```bash
npm install
npm run build
npm run pack:dist
```

This creates `opencode-elf-<version>.tgz`. On the target machine run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-elf.ps1 -Tarball .\opencode-elf-0.7.0.tgz
```

The script installs the plugin to `%USERPROFILE%\.config\opencode\plugins\opencode-elf` and runs `npm install` there.

### Option 2: Global plugins directory (manual)

Copy the package into the OpenCode config directory:

```text
~/.config/opencode/plugins/opencode-elf/
```

OpenCode discovers global plugins under `~/.config/opencode/plugins/` automatically. No config entry is needed.

### Option 3: Git package

```bash
opencode plugin add github:josejaviercanon/opencode-elf
```

### Configuration

If an older `opencode-elf` entry is still present in `plugins`, remove it. OpenCode resolves bare names from npm and would load the old V1 package:

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    // "opencode-elf"  <- remove: the local plugin is auto-discovered
  ]
}
```

Restart the service after installing:

```bash
opencode service restart
opencode plugin list
```

First run downloads the embedding model (~90 MB) into the plugin cache.

### Verify

Ask OpenCode to use the `elf` tool, or check the service log for `ELF: Ready`.

## Running with opencode-mem

opencode-mem and opencode-elf cover different cognitive domains and form a complementary pair. They do not crash each other and can run together.

- [opencode-mem](https://github.com/tickernelz/opencode-mem) is the **Architect**: static project rules, memory layouts, user profile preferences, and domain knowledge.
- opencode-elf is the **Supervisor**: it records tool failures after they happen (build failures, CLI syntax errors, failing tests) and injects relevant past learnings into later requests. It does not edit the failing command mid-flight.

Two costs to manage when running both:

1. **Context window.** Each plugin injects its own memory block. ELF injects only when it has relevant rules, learnings, or heuristics. Compressing tool output (for example with [openrtk](https://github.com/josejaviercanon/openrtk)) keeps room for both.
2. **CPU.** Each plugin runs its own local embedding pipeline in the background: ELF uses `@xenova/transformers` (all-MiniLM-L6-v2, ~90 MB model), opencode-mem uses `@huggingface/transformers`. A multi-core CPU handles both; indexing a large failure log can cause a brief spike.

Boundary rules:

- Save architecture documents, user preferences, and domain knowledge with opencode-mem.
- Let ELF capture terminal errors, syntax corrections, and build failures automatically. Do not duplicate architectural rules into ELF.

This fork was developed and verified with opencode-mem loaded simultaneously.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│              OpenCode ELF Plugin                     │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Initialization: LAZY LOADING                        │
│  ┌────────────────────────────────────────────────┐  │
│  │ Background: DB init + Model load + Seeding     │  │
│  │ Returns hooks immediately (non-blocking)       │  │
│  │ First interaction waits for init completion    │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  Hooks:                                              │
│  ┌─────────────────┐      ┌────────────────────┐     │
│  │  context hook   │─────▶│ Context Injection  │     │
│  │  (pre-LLM)      │      │ - Golden Rules     │     │
│  │                 │      │ - Past Learnings   │     │
│  │                 │      │ - Heuristics       │     │
│  └─────────────────┘      └────────────────────┘     │
│                                                      │
│  ┌─────────────────┐      ┌────────────────────┐     │
│  │  tool hook      │─────▶│ Learning Loop      │     │
│  │  execute.after  │      │ - Record failures  │     │
│  │                 │      │ - Record successes │     │
│  │                 │      │ - Utility Feedback │     │
│  └─────────────────┘      └────────────────────┘     │
│                                                      │
│  Consolidation:                                      │
│  ┌─────────────────┐      ┌────────────────────┐     │
│  │  Emergence Loop │─────▶│ Memory Promotion   │     │
│  │  (Periodic)     │      │ Cluster Learnings  │     │
│  └─────────────────┘      └────────────────────┘     │
│                                                      │
│  Storage:                                            │
│  ┌──────────────────────────────────────────────┐    │
│  │  SQLite (node:sqlite, libsql fallback)       │    │
│  │  ~/.opencode/elf/memory.db                   │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  Embeddings:                                         │
│  ┌──────────────────────────────────────────────┐    │
│  │  @xenova/transformers                        │    │
│  │  Model: Xenova/all-MiniLM-L6-v2              │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
└──────────────────────────────────────────────────────┘
```

## How It Works

### Context Injection (Before each message)

When you send a message to OpenCode, ELF:
1. Generates an embedding for your message
2. Searches for relevant Golden Rules and past Learnings
3. Injects this context into the system prompt

Example injection:
```
[ELF MEMORY]

Golden Rules:
- Always validate user inputs before processing
- Use TypeScript strict mode for type safety
- This project requires JWT authentication [project]

Relevant Past Experiences:
✗ [85%] Tool 'bash' failed: command not found - npm
✗ [78%] API authentication failed without JWT token [project]

Applicable Heuristics:
- When working with npm, always check if node_modules exists
```

### Learning Loop (After each tool execution)

When a tool executes, ELF:
1. Monitors the result (stdout, stderr, exit codes)
2. Records failures automatically to project database
3. Stores them with embeddings for future retrieval

### Agent Tool (Programmatic Access)

The plugin provides an `elf` tool that agents can invoke to manage memory:

**Available modes:**
- `rules-list` - List all golden rules (optional `scope: "global" | "project"`)
- `heuristics-list` - List all heuristics (optional `scope`)
- `learnings-list` - View recent learnings (optional `limit` and `scope`)
- `rules-add` - Add new golden rule (auto-generates embeddings, optional `scope`)
- `heuristics-add` - Add new heuristic pattern (optional `scope`)
- `metrics` - View performance metrics
- `search` - Hybrid search across all learnings (requires `query`, optional `limit`)

**Examples:**
```
"Add a global rule: Always use async/await"
"Add a project rule: This API requires authentication tokens"
"Show me project-specific golden rules"
"List all learnings from this project"
"Search learnings for error code ENOENT"
```

## Quick Start

### 1. Installation & First Run

After installing the plugin, restart OpenCode. The plugin uses **lazy loading** for fast startup:

**What happens:**
- OpenCode starts immediately (plugin loads in background)
- Database initialization happens asynchronously
- Embedding model loads in background (~90MB download on first run)
- Default data seeding occurs if needed (first run only)

You'll see output like:
```
ELF: Initializing in background...
ELF: Ready (took 2847ms)
```

**First interaction timing:**
- Your first message will wait for initialization to complete (1-3 seconds)
- Subsequent messages are instant (no waiting)
- This moves the "loading time" from startup to first use

The plugin is ready to use! No manual setup required.

### 2. Verify Installation (Optional)

If you're developing locally, you can run the simulation test to verify everything works:

```bash
npm run test:simulate
```

Expected output:
```
🤖 Starting ELF Simulation...

1️⃣  Seeding Golden Rule...
ELF: Loading embedding model...
ELF: Model loaded.

2️⃣  Simulating Chat Request...
✅ SUCCESS: Context injected Golden Rule into system prompt.

3️⃣  Simulating Tool Failure...
✅ Tool failure event processed.

4️⃣  Verifying Learning Retrieval...
✅ SUCCESS: Retrieved the learned failure from memory.

🎉 Simulation Complete.
```

### 3. Start Using OpenCode

The plugin now works automatically! Golden rules and learnings will be injected into conversations as context.

## Managing Data

The plugin automatically seeds default data on first run. You can view and manage this data in three ways:

### 1. Natural Conversation (Recommended)

Simply ask OpenCode to manage your ELF memory in natural language:

```
"Add a golden rule: Always use async/await instead of callbacks"
"Add a project-specific rule: This API requires JWT authentication"
"Show me my current golden rules"
"Show me project-specific learnings"
"Add a heuristic for npm errors"
"What have I learned recently?"
```

OpenCode will automatically invoke the `elf` tool to:
- Add new golden rules (with automatic embedding generation)
- Add new heuristics
- List rules, heuristics, and learnings
- View performance metrics

### 2. Optional: Slash Commands

If you prefer slash commands for quick inspection, you can add them to your OpenCode config:

```jsonc
// opencode.jsonc or ~/.config/opencode/opencode.jsonc
{
  "commands": {
    "elf": {
      "template": "Use the elf tool. Arguments: $ARGUMENTS",
      "description": "ELF memory system. Commands: rules list, heuristics list, learnings list, search, metrics, rules add, heuristics add"
    }
  }
}
```

Then you can use:
```
/elf
/elf rules list
/elf search "error code 503"
/elf metrics
```

### 3. Using CLI Tools (Advanced)

For local development or advanced management, use the npm scripts (requires plugin directory access):

#### Golden Rules

Golden Rules are constitutional principles that should always guide the AI's behavior.

```bash
# Add a new rule
npm run rules:add "Always validate inputs before processing"

# List all rules
npm run rules:list

# Re-seed default rules (if you deleted them)
npm run rules:seed
```

#### Heuristics

Heuristics are pattern-based suggestions triggered by regex matching.

```bash
# Add a new heuristic
npm run heuristics:add "npm install" "Check package.json exists first"

# List all heuristics
npm run heuristics:list

# Re-seed default heuristics (if you deleted them)
npm run heuristics:seed
```

#### Learnings

View recorded successes and failures:

```bash
# View all learnings
npm run learnings:view

# View only failures
npm run learnings:view failure

# View only successes
npm run learnings:view success
```

### Performance Metrics

Track ELF's performance and usage:

```bash
npm run metrics:view
```

This shows:
- Average latency for context injection
- Total context injections
- Failures learned
- Recent activity

### Cleanup & Maintenance

ELF includes automatic cleanup to prevent the database from growing indefinitely:

**Automatic Cleanup (Default: Enabled)**
- Runs once per day during normal operation
- Deletes golden rules with 0 hits after 90 days
- Deletes learnings older than 60 days
- Deletes heuristics older than 180 days

**Manual Cleanup:**
```bash
# Preview what would be deleted
npm run cleanup:preview

# Delete expired data
npm run cleanup:clean
```

**Configuration:**
Edit `src/config.ts` to customize expiration settings:
```typescript
export const RULE_EXPIRATION_DAYS = 90;        // Delete unused rules
export const RULE_MIN_HITS_TO_KEEP = 1;        // Rules with < 1 hits
export const LEARNING_EXPIRATION_DAYS = 60;    // Delete old learnings
export const HEURISTIC_EXPIRATION_DAYS = 180;  // Delete old heuristics
export const AUTO_CLEANUP_ENABLED = true;      // Enable/disable auto-cleanup
```

After editing config, rebuild with `npm run build`.

## Configuration

The plugin can be configured by modifying `src/config.ts` and rebuilding with `npm run build`.

### Query & Performance Settings

```typescript
// Query limits
export const MAX_GOLDEN_RULES = 5;             // Max rules to inject per message
export const MAX_RELEVANT_LEARNINGS = 10;      // Max learnings to inject
export const SIMILARITY_THRESHOLD = 0.7;       // Min similarity for relevance

// Embedding model
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

// Hybrid storage
export const ENABLE_HYBRID_STORAGE = true;     // Enable project-scoped memories
```

### Expiration Settings

```typescript
export const RULE_EXPIRATION_DAYS = 90;        // Delete unused rules after 90 days
export const RULE_MIN_HITS_TO_KEEP = 1;        // Rules with 0 hits are candidates
export const LEARNING_EXPIRATION_DAYS = 60;    // Delete learnings after 60 days
export const HEURISTIC_EXPIRATION_DAYS = 180;  // Delete heuristics after 180 days
export const AUTO_CLEANUP_ENABLED = true;      // Enable automatic cleanup
```

### Database Locations

**Global Storage** (cross-project):
- **macOS/Linux**: `~/.opencode/elf/memory.db`
- **Windows**: `C:\Users\<username>\.opencode\elf\memory.db`

**Project Storage** (project-specific):
- `<project-root>/.opencode/elf/memory.db`
- Automatically detected by finding `.git` or `.opencode` directories

To query the database directly:
```bash
sqlite3 ~/.opencode/elf/memory.db "SELECT * FROM golden_rules"
```

To reset all data:
```bash
rm -rf ~/.opencode/elf/
```

## Database Schema

The plugin uses SQLite with the following tables:

### golden_rules
- `id` (TEXT PK)
- `content` (TEXT)
- `embedding` (TEXT - JSON array)
- `created_at` (INTEGER - timestamp)
- `hit_count` (INTEGER - usage tracking)

### learnings
- `id` (TEXT PK)
- `content` (TEXT)
- `category` ('success' | 'failure')
- `embedding` (TEXT - JSON array)
- `created_at` (INTEGER)
- `context_hash` (TEXT - for deduplication)

### learnings_fts (FTS5 Virtual Table)
- Full-text search index on learnings
- Synced automatically via triggers
- Enables fast keyword-based search

### heuristics
- `id` (TEXT PK)
- `pattern` (TEXT - regex)
- `suggestion` (TEXT)
- `created_at` (INTEGER)

## Project Structure

```
opencode-elf/
├── package.json              # Dependencies & scripts
├── tsconfig.json             # TypeScript config
├── index.ts                  # OpenCode discovery entry (re-exports dist)
├── README.md                 # This file
├── LICENSE                   # MIT license
│
├── src/
│   ├── index.ts              # Plugin entry (V2 hooks and tools)
│   ├── config.ts             # Configuration
│   │
│   ├── types/
│   │   └── elf.ts            # TypeScript types
│   │
│   ├── db/
│   │   └── client.ts         # Database engine & schema
│   │
│   └── services/
│       ├── embeddings.ts     # Vector embeddings
│       ├── metrics.ts        # Performance tracking
│       ├── query.ts          # Context builder
│       └── cleanup.ts        # Automatic data cleanup
│
├── scripts/
│   ├── install-elf.ps1       # Windows installer for other machines
│   ├── prepare.mjs           # Build guard used by npm install
│   ├── manage-rules.js       # CLI: add/list/delete rules
│   ├── manage-heuristics.js  # CLI: add/list/delete heuristics
│   ├── view-learnings.js     # CLI: view learnings
│   ├── view-metrics.js       # CLI: view metrics
│   ├── cleanup-expired.js    # CLI: cleanup expired data
│   ├── seed-rules.js         # Seed default rules
│   └── seed-heuristics.js    # Seed default heuristics
│
└── tests/
    ├── simulate.ts           # End-to-end simulation
    ├── test-hybrid.ts        # Hybrid storage tests
    └── benchmark.ts          # Performance benchmarks
```

## Development

### Building and Packaging

```bash
# Install dependencies
npm install

# Build for production
npm run build

# Create a distributable tarball (runs the build first)
npm run pack:dist
```

### Local Development Installation

For development, build the plugin and install it into the OpenCode global plugins directory:

```bash
npm install
npm run build
npm run pack:dist
powershell -ExecutionPolicy Bypass -File scripts\install-elf.ps1 -Tarball .\opencode-elf-0.7.0.tgz
```

Restart the service after installing:

```bash
opencode service restart
opencode plugin list
```

### OpenCode V2 notes

The plugin targets the V2 plugin API. Two loader constraints shaped the implementation:

- OpenCode resolves only relative imports while loading a plugin, so runtime dependencies (`node:sqlite`, `@xenova/transformers`) are imported dynamically instead of statically. `@opencode/plugin` is a type-only import.
- SQLite uses Node's built-in `node:sqlite` (Node 22+, Bun) with `@libsql/client` as a fallback for older Node versions.

## Troubleshooting

### Plugin Not Loading
- Check the OpenCode log for `failed to load plugin`
- Verify the plugin directory exists: `~/.config/opencode/plugins/opencode-elf`
- Ensure `dist/` exists inside that directory (the tarball ships it)
- Remove any `opencode-elf` entry from `plugins` in `opencode.jsonc` (auto-discovery replaces it)
- Check for TypeScript compilation errors with `npm run build`

### Embedding Model Download
First run will download the model (~90MB). This takes 1-2 minutes. Subsequent runs are instant.

### Performance Issues

Expected performance (lazy loading + optimizations enabled):

| Operation | First Run | Subsequent Runs | With Cache |
|-----------|-----------|-----------------|------------|
| Plugin startup | Returns immediately | Instant | - |
| First message | 1-3s (waits for init) | ~200-500ms | ~100-200ms |
| Context query | ~200-500ms | ~200-500ms | ~100-200ms |
| Add golden rule | ~50-100ms | ~50-100ms | - |
| Record learning | ~100-200ms | ~100-200ms | - |

**Performance Optimizations:**
- ✅ **Parallel Database Queries**: Global + project databases queried simultaneously (30-50% faster)
- ✅ **Embedding Cache**: LRU cache with 5-min TTL (60-70% faster on repeated prompts)
- ✅ **Lazy Loading**: Non-blocking startup (OpenCode ready instantly)

**Note:** With lazy loading, OpenCode starts immediately. Initialization happens in the background, so only your first interaction waits for the model to load.

If performance is slower than expected, check:
- Model is loaded (check logs for "ELF: Ready")
- Database isn't locked
- Sufficient disk space for embeddings cache (~90MB)
- First message timing is expected (includes initialization)

**Run performance benchmark:**
```bash
npm run test:benchmark
```

## Roadmap

- [x] Core learning loop
- [x] Golden rules
- [x] Heuristics
- [x] CLI management tools
- [x] Performance metrics
- [x] Simulation testing
- [x] **Hybrid storage (global + project-scoped memories)**
- [x] **Performance optimizations (parallel queries + embedding cache)**
- [x] **Hybrid search (vector + FTS5 full-text search)**
- [x] **Privacy controls (`<private>` tag filtering)**
- [x] **Confidence & Utility Tracking (Feedback loop)**
- [x] **Success Pattern Detection**
- [x] **Memory Consolidation Loop (Emergence)**
- [ ] Experiment tracking (hypothesis testing)
- [ ] Decision records (ADRs)
- [ ] Vector index optimization (avoid scanning all learnings)
- [ ] Export/import memory database
- [ ] Analytics dashboard
- [ ] Web UI for management

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Development Workflow

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests: `npm run test:simulate`
5. Build: `npm run build`
6. Commit your changes: `git commit -m 'Add my feature'`
7. Push to the branch: `git push origin feature/my-feature`
8. Submit a pull request

### Code Style

- Use TypeScript strict mode
- Follow existing code patterns
- Add JSDoc comments for public APIs
- Keep functions small and focused

## License

MIT
