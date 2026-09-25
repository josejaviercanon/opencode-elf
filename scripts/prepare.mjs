// Builds the plugin when devDependencies are available.
//
// npm runs "prepare" both for local development and when the package is
// installed from a git repository. Tarball installs omit devDependencies and
// already ship a built dist/, so this script exits without building when
// typescript is not installed.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

let tsc;
try {
  tsc = require.resolve("typescript/bin/tsc");
} catch {
  console.log("prepare: typescript not installed, skipping build (dist is prebuilt)");
  process.exit(0);
}

const result = spawnSync(process.execPath, [tsc], { stdio: "inherit" });
process.exit(result.status ?? 1);
