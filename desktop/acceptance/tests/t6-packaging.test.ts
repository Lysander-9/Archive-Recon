import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { ACCEPTANCE_ROOT, DESKTOP_ROOT, fixturePath, loadManifest, readFixtureBytes, sha256 } from "../harness/fixtures.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__pycache__") continue;
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

test("T6: fixture manifest hashes match the committed bytes", () => {
  const manifest = loadManifest();
  assert.ok(manifest.entries.length >= 15);
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
    /\.(ts|mjs|js|json)$/.test(file) && !file.endsWith("t6-packaging.test.ts")
  );
  for (const file of executableFiles) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/child_process[^\n]*python/i.test(text), `Python subprocess reference in ${file}`);
    assert.ok(!/spawn(Sync)?\([^)]*["']python/i.test(text), `Python spawn in ${file}`);
  }
});

test("T6: desktop package/distribution contract is not yet available", { skip: existsSync(path.join(DESKTOP_ROOT, "package.json")) ? false : "desktop/package.json has not been delivered yet" }, () => {
  const pkg = JSON.parse(readFileSync(path.join(DESKTOP_ROOT, "package.json"), "utf8"));
  assert.ok(!Object.keys(pkg.dependencies ?? {}).some((name) => name.includes("python")));
  for (const script of ["typecheck", "test", "build", "test:e2e", "dist:win"]) {
    assert.ok(pkg.scripts?.[script], `missing npm script: ${script}`);
  }
});

test("T6: packaged Windows ZIP without Node/Python is not yet verifiable", { skip: "no win-unpacked ZIP exists yet; final mandatory check after the integration build" }, () => {
  assert.fail("unreachable");
});
