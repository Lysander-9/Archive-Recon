#!/usr/bin/env node
/**
 * Runs the independent acceptance suite against the production modules.
 *
 * 1. Bundles harness/production-entry.ts with esbuild (production code only;
 *    no reference implementation is imported by the tests).
 * 2. Runs the Node test runner over desktop/acceptance/tests.
 */

import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTS = path.join(HERE, "tests");
const GENERATED = path.join(HERE, "harness", "generated");

async function prepare() {
  await rm(GENERATED, { recursive: true, force: true });
  await mkdir(GENERATED, { recursive: true });
  await build({
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    logLevel: "warning",
    entryPoints: [path.join(HERE, "harness", "production-entry.ts")],
    outfile: path.join(GENERATED, "production.mjs"),
  });
}

await prepare();
const files = readdirSync(TESTS)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join(TESTS, name));

console.log(`production acceptance tests=${files.length}`);
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
