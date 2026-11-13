#!/usr/bin/env node
/** Bundles the production entry (and the Electron proxy entry) for acceptance. */

import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GENERATED = path.join(HERE, "harness", "generated");
const PROXY_GENERATED = path.join(HERE, "proxy", "generated");

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  sourcemap: false,
  logLevel: "warning",
};

async function prepare() {
  await rm(GENERATED, { recursive: true, force: true });
  await mkdir(GENERATED, { recursive: true });
  await build({
    ...common,
    entryPoints: [path.join(HERE, "harness", "production-entry.ts")],
    outfile: path.join(GENERATED, "production.mjs"),
    format: "esm",
  });

  await rm(PROXY_GENERATED, { recursive: true, force: true });
  await mkdir(PROXY_GENERATED, { recursive: true });
  await build({
    ...common,
    entryPoints: [path.join(HERE, "proxy", "run-proxy-acceptance.ts")],
    outfile: path.join(PROXY_GENERATED, "run-proxy-acceptance.cjs"),
    format: "cjs",
    external: ["electron"],
  });
}

prepare().catch((error) => {
  console.error(error);
  process.exit(1);
});
