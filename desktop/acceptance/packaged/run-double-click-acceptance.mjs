/**
 * Independent packaged double-click acceptance: two immediate UI clicks while
 * the first query is in flight must produce exactly one Wayback request group.
 *
 * Usage: node acceptance/packaged/run-double-click-acceptance.mjs
 */

import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "..", "..");
const executable = process.env.ARCHRECON_PACKAGED_EXE
  ?? path.join(DESKTOP, "release", "win-unpacked", "Archive Recon.exe");

const rows = [
  ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
  ["k1", "20240102030405", "https://example.com/a", "text/html", "200", "D1", "10"],
  ["k2", "20240103040506", "https://example.com/b", "text/html", "200", "D2", "20"],
  ["k3", "20240104050607", "https://example.com/c", "text/html", "200", "D3", "30"],
];
let waybackHits = 0;
let baseUrl = "";
const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", baseUrl);
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (url.pathname === "/wayback") {
    waybackHits += 1;
    setTimeout(() => response.end(JSON.stringify(rows)), 300);
    return;
  }
  if (url.pathname === "/cc/collinfo.json") {
    response.end("[]");
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app;
let result = { ok: false };
try {
  await fs.access(executable);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  app = await electron.launch({
    executablePath: executable,
    env: {
      ...process.env,
      ARCHRECON_TEST_MODE: "1",
      ARCHRECON_WAYBACK_URL: `${baseUrl}/wayback`,
      ARCHRECON_CC_INDEX_BASE: `${baseUrl}/cc`,
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="target-input"]', { timeout: 20_000 });
  await page.fill('[data-testid="target-input"]', "example.com");
  await page.dblclick('[data-testid="start-button"]');
  await sleep(1500);
  result = {
    ok: waybackHits === 1,
    waybackHits,
    expected: 1,
    detail: waybackHits === 1
      ? "one request group"
      : "double click created multiple request groups",
  };
} catch (error) {
  result = { ok: false, error: error instanceof Error ? error.message : String(error) };
} finally {
  await app?.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  console.log(`DOUBLE_CLICK_ACCEPTANCE_RESULT ${JSON.stringify(result)}`);
  process.exit(result.ok ? 0 : 1);
}
