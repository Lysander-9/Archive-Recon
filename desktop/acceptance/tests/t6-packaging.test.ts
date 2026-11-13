import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  ACCEPTANCE_ROOT,
  DESKTOP_ROOT,
  fixturePath,
  loadManifest,
  readFixtureBytes,
  sha256,
} from "../harness/fixtures.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__pycache__" || name === "generated") continue;
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

test("T6: fixture manifest hashes match the committed bytes", () => {
  const manifest = loadManifest();
  assert.ok(manifest.entries.length >= 17);
  for (const entry of manifest.entries) {
    const bytes = readFileSync(path.join(ACCEPTANCE_ROOT, entry.path));
    assert.equal(sha256(bytes), entry.sha256, `fixture changed: ${entry.path}`);
  }
});

test("T6: the original five-field sample is preserved unchanged", () => {
  const bytes = readFixtureBytes("export", "reference-baseline-sample.csv");
  assert.equal(sha256(bytes), "9e8dfc69f51edfaf1ad76f650cd889ef9c25c582ef6a8fdb7c619eac9bdef517");
});

test("T6: acceptance assets contain no Python and no Python subprocess calls", () => {
  const files = walk(ACCEPTANCE_ROOT);
  assert.deepEqual(files.filter((file) => file.endsWith(".py")), []);
  const executableFiles = files.filter((file) =>
    /\.(ts|mjs|js)$/.test(file) && !file.endsWith("t6-packaging.test.ts")
  );
  for (const file of executableFiles) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/child_process[^\n]*python/i.test(text), `Python subprocess reference in ${file}`);
    assert.ok(!/spawn(Sync)?\([^)]*["']python/i.test(text), `Python spawn in ${file}`);
  }
});

test("T6: production package scripts, dependencies and builder whitelist", () => {
  const pkg = JSON.parse(readFileSync(path.join(DESKTOP_ROOT, "package.json"), "utf8"));
  for (const script of ["typecheck", "test", "build", "test:e2e", "dist:win"]) {
    assert.ok(pkg.scripts?.[script], `missing npm script: ${script}`);
  }
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.equal(pkg.devDependencies?.electron, "45.3.1");
  assert.equal(pkg.devDependencies?.typescript, "7.0.2");
  assert.equal(pkg.devDependencies?.esbuild, "0.28.2");
  assert.equal(pkg.devDependencies?.["electron-builder"], "26.18.0");
  assert.equal(pkg.devDependencies?.["@playwright/test"], "1.65.0");
  assert.equal(pkg.devDependencies?.["@types/node"], "24.19.2");

  const builder = JSON.parse(readFileSync(path.join(DESKTOP_ROOT, "electron-builder.json"), "utf8"));
  assert.deepEqual(builder.files, ["dist/**/*", "package.json"]);
  assert.equal(builder.win?.target?.[0]?.target, "zip");
  assert.deepEqual(builder.win?.target?.[0]?.arch, ["x64"]);
  assert.ok(!JSON.stringify(builder.files).includes("tests"));
  assert.ok(!JSON.stringify(builder.files).includes(".py"));
});

test("T6: packaged Windows ZIP without Node/Python is not yet verifiable", { skip: "release ZIP exists, but no clean Windows environment without Node/Python is available; local packaged-exe smoke is not a substitute" }, () => {
  assert.fail("unreachable");
});
