import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.cwd());
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "main"), { recursive: true });
await mkdir(path.join(dist, "preload"), { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  sourcemap: false,
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: [path.join(root, "src/main/main.ts")],
  outfile: path.join(dist, "main/main.js"),
});

await build({
  ...common,
  entryPoints: [path.join(root, "src/preload/preload.ts")],
  outfile: path.join(dist, "preload/preload.js"),
});

await cp(path.join(root, "src/renderer"), path.join(dist, "renderer"), { recursive: true });
console.log("build complete: desktop/dist");
