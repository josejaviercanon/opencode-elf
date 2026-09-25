/**
 * Compatibility checks for the opencode-elf native stack and degraded mode.
 *
 * Covers the co-install defects fixed in this fork:
 *   1. onnxruntime-node pinned to 1.20.1 (base-name ordinal conflict, error 182)
 *   2. sharp pinned to 0.35.4 (libvips-42.dll conflict, error 127)
 *   3. graceful degradation when the embedding model cannot load
 *
 * Run after `npm run build` and `npm install`:
 *   npm run test:compat
 *
 * The test fails with a non-zero exit code on the first failed assertion.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const ORT_DLL = join(
  ROOT,
  "node_modules",
  "onnxruntime-node",
  "bin",
  "napi-v3",
  "win32",
  "x64",
  "onnxruntime.dll"
);
const MEM_ORT_DLL = join(
  "..",
  "opencode-mem",
  "node_modules",
  "onnxruntime-node",
  "bin",
  "napi-v3",
  "win32",
  "x64",
  "onnxruntime.dll"
);

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main(): Promise<void> {
  // 1. Pinned native versions in package.json overrides.
  const pkg = readJson(join(ROOT, "package.json"));
  const overrides = (pkg.overrides ?? {}) as Record<string, string>;
  assert.equal(overrides["onnxruntime-node"], "1.20.1", "onnxruntime-node override must be 1.20.1");
  assert.equal(overrides["onnxruntime-web"], "1.20.1", "onnxruntime-web override must be 1.20.1");
  assert.equal(overrides["sharp"], "0.35.4", "sharp override must be 0.35.4");
  console.log("ok  package.json pins onnxruntime-node/onnxruntime-web 1.20.1 + sharp 0.35.4");

  // 2. Installed native packages match the pins.
  const installedOrt = join(ROOT, "node_modules", "onnxruntime-node", "package.json");
  const installedSharp = join(ROOT, "node_modules", "sharp", "package.json");
  let depsInstalled = true;

  if (existsSync(installedOrt)) {
    const version = readJson(installedOrt).version as string;
    assert.equal(version, "1.20.1", `installed onnxruntime-node must be 1.20.1, found ${version}`);
    console.log("ok  installed onnxruntime-node is 1.20.1");
  } else {
    depsInstalled = false;
    console.log("skip onnxruntime-node not installed (run npm install)");
  }

  if (existsSync(installedSharp)) {
    const version = readJson(installedSharp).version as string;
    assert.equal(version, "0.35.4", `installed sharp must be 0.35.4, found ${version}`);
    console.log("ok  installed sharp is 0.35.4");
  } else {
    depsInstalled = false;
    console.log("skip sharp not installed (run npm install)");
  }

  // 3. Bundled Windows DLL present, and identical to opencode-mem's copy when
  //    that checkout sits next to this one. Identical bytes guarantee the
  //    loader cannot mix ordinals across the two plugins.
  if (process.platform === "win32" && depsInstalled) {
    assert.ok(existsSync(ORT_DLL), `onnxruntime.dll missing at ${ORT_DLL}`);
    console.log("ok  bundled onnxruntime.dll present");

    if (existsSync(MEM_ORT_DLL)) {
      const elfHash = sha256(ORT_DLL);
      const memHash = sha256(MEM_ORT_DLL);
      assert.equal(elfHash, memHash, "ELF and opencode-mem onnxruntime.dll builds must match");
      console.log("ok  onnxruntime.dll matches opencode-mem (same SHA-256)");
    } else {
      console.log("skip opencode-mem checkout not present; cross-plugin DLL hash not compared");
    }
  }

  // 4. Embedding pipeline loads and produces a vector.
  const { embeddingService } = await import("../dist/services/embeddings.js");
  await embeddingService.init();
  const vector = await embeddingService.generate("compatibility check");
  assert.equal(vector.length, 384, "all-MiniLM-L6-v2 embeddings must have 384 dimensions");
  console.log("ok  embedding model loads and returns 384-dimension vectors");

  // 5. Degraded mode: DB-backed operations survive an embedding failure.
  const { initDatabase } = await import("../dist/db/client.js");
  const { QueryService } = await import("../dist/services/query.js");
  const { GLOBAL_DB_PATH } = await import("../dist/config.js");

  await initDatabase(GLOBAL_DB_PATH);
  // Use a temp directory so the query service finds no project marker and
  // touches only the global database.
  const tempDir = mkdtempSync(join(tmpdir(), "elf-compat-"));
  const queryService = new QueryService(tempDir);

  // Simulate the Windows native-load failure.
  (embeddingService as unknown as { generate: () => Promise<number[]> }).generate = async () => {
    throw new Error("simulated embedding failure");
  };

  const keyword = await queryService.searchFTS("npm");
  console.log(`ok  keyword (FTS) search works without embeddings (${keyword.length} rows)`);

  const hybrid = await queryService.searchHybrid("npm");
  assert.ok(Array.isArray(hybrid), "hybrid search must fall back to keyword results, not throw");
  console.log(`ok  hybrid search degrades to keyword results (${hybrid.length} rows)`);

  const recorded = await queryService.recordLearning(
    "compat test learning",
    "failure",
    `compat-test-${Date.now()}`,
    "global"
  );
  assert.equal(recorded, undefined, "recordLearning must return without throwing when embeddings fail");
  console.log("ok  recordLearning degrades silently when embeddings fail");

  rmSync(tempDir, { recursive: true, force: true });

  console.log("\nCompatibility test passed.");
}

main().catch((error) => {
  console.error("\nCompatibility test FAILED:", error);
  process.exit(1);
});
