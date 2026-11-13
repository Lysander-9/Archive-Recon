/**
 * Independent packaged acceptance: launches the real win-unpacked executable,
 * waits for the exact terminal text "完成" (not "部分完成"), then retries the
 * row count assertion. No reference implementation is involved.
 *
 * Usage:
 *   node acceptance/packaged/run-packaged-acceptance.mjs
 */

import http from "node:http";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "..", "..");
const executable = process.env.ARCHRECON_PACKAGED_EXE
  ?? path.join(DESKTOP, "release", "win-unpacked", "Archive Recon.exe");

const waybackRows = [
  ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
  ["k1", "20240102030405", "https://example.com/a", "text/html", "200", "D1", "10"],
  ["k2", "20240103040506", "https://example.com/b", "text/html", "200", "D2", "20"],
  ["k3", "20240104050607", "https://www.example.com/c", "application/pdf", "301", "D3", "30"],
  ["k4", "20240105060708", "https://example.com/a", "text/html", "200", "D4", "99"],
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let baseUrl = "";
const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", baseUrl);
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (url.pathname === "/wayback") {
    response.end(JSON.stringify(waybackRows));
    return;
  }
  if (url.pathname === "/cc/collinfo.json") {
    response.end(JSON.stringify([]));
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});

let app;
let tempDir;
let result = { ok: false };
try {
  await fs.access(executable);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-packaged-acceptance-"));

  app = await electron.launch({
    executablePath: executable,
    env: {
      ...process.env,
      ARCHRECON_TEST_MODE: "1",
      ARCHRECON_WAYBACK_URL: `${baseUrl}/wayback`,
      ARCHRECON_CC_INDEX_BASE: `${baseUrl}/cc`,
      ARCHRECON_EXPORT_DIR: tempDir,
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="target-input"]', { timeout: 20_000 });
  const title = await page.title();

  await page.fill('[data-testid="target-input"]', "example.com");
  await page.click('[data-testid="start-button"]');

  // Exact terminal text: "部分完成" must not satisfy this wait.
  await page.waitForFunction(
    () => document.querySelector('[data-testid="status-chip"]')?.textContent?.trim() === "完成",
    null,
    { timeout: 30_000 },
  );
  const status = (await page.locator('[data-testid="status-chip"]').textContent())?.trim();

  const deadline = Date.now() + 20_000;
  let rows = await page.locator("#rows-body tr").count();
  while (rows !== 3 && Date.now() < deadline) {
    await sleep(100);
    rows = await page.locator("#rows-body tr").count();
  }
  if (rows !== 3) throw new Error(`expected 3 rows after retry, got ${rows}`);

  await page.click('[data-testid="export-csv"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="notice"]')?.textContent?.includes("已导出 3 条记录"),
    null,
    { timeout: 10_000 },
  );
  const files = (await fs.readdir(tempDir)).filter((name) => name.endsWith(".csv"));
  if (files.length !== 1) throw new Error(`expected one CSV, got ${files.length}`);
  const csv = await fs.readFile(path.join(tempDir, files[0]));
  const text = csv.toString("utf8");
  if (csv.subarray(0, 3).toString("hex") !== "efbbbf") throw new Error("missing BOM");
  if (!text.slice(1).startsWith("timestamp,status_code,length,file_type,url\r\n")) {
    throw new Error("unexpected CSV header");
  }
  if (text.trim().split("\r\n").length !== 4) throw new Error("unexpected CSV row count");

  result = {
    ok: true,
    title,
    status,
    rows,
    csvFile: path.basename(files[0]),
    csvBytes: csv.length,
  };
} catch (error) {
  result = { ok: false, error: error instanceof Error ? error.message : String(error) };
} finally {
  await app?.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  console.log(`PACKAGED_ACCEPTANCE_RESULT ${JSON.stringify(result)}`);
  process.exit(result.ok ? 0 : 1);
}
