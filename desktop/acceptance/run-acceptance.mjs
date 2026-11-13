#!/usr/bin/env node
/**
 * Runs the independent acceptance suite with the built-in Node test runner.
 *
 * No npm dependencies are required: Node >= 22.6 can strip TypeScript types.
 * The runner never invokes Python.
 */

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTS = path.join(HERE, "tests");
const legacy = process.argv.includes("--legacy");
const files = readdirSync(TESTS)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join(TESTS, name));

console.log(`mode=${legacy ? "legacy" : "reference"} tests=${files.length}`);
const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: {
    ...process.env,
    ARCHRECON_IUT_MODE: legacy ? "legacy" : "reference",
  },
});
process.exit(result.status ?? 1);
