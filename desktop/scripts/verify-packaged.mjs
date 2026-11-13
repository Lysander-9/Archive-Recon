/**
 * Verify the built Windows package actually launches and runs the offline data flow.
 * Uses only the packaged executable plus a loopback fixture server (no Node/Python needed
 * for the app itself; Node here is only the test driver).
 */
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { _electron as electron } from "playwright";

const root = path.resolve(process.cwd());
const executablePath = path.join(root, "release", "win-unpacked", "Archive Recon.exe");

try {
  await fs.access(executablePath);
} catch {
  console.error(`missing packaged executable: ${executablePath}`);
  process.exit(1);
}

const waybackRows = [
  ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
  ["k1", "20240102030405", "https://example.com/a", "text/html", "200", "D1", "10"],
  ["k2", "20240103040506", "https://example.com/b", "text/html", "200", "D2", "20"],
  ["k3", "20240104050607", "https://www.example.com/c", "application/pdf", "301", "D3", "30"],
];

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
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
baseUrl = `http://127.0.0.1:${server.address().port}`;

const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-packaged-"));

const app = await electron.launch({
  executablePath,
  env: {
    ...process.env,
    ARCHRECON_TEST_MODE: "1",
    ARCHRECON_WAYBACK_URL: `${baseUrl}/wayback`,
    ARCHRECON_CC_INDEX_BASE: `${baseUrl}/cc`,
    ARCHRECON_EXPORT_DIR: exportDir,
  },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="target-input"]');
  const title = await page.title();
  if (title !== "Archive Recon") throw new Error(`unexpected title: ${title}`);

  await page.fill('[data-testid="target-input"]', "example.com");
  await page.click('[data-testid="start-button"]');
  await page.waitForSelector('[data-testid="status-chip"]:has-text("完成")', { timeout: 20_000 });
  const rowCount = await page.locator("#rows-body tr").count();
  if (rowCount !== 3) throw new Error(`expected 3 rows, got ${rowCount}`);

  await page.click('[data-testid="export-csv"]');
  await page.waitForSelector('[data-testid="notice"]:has-text("已导出 3 条记录")', { timeout: 10_000 });
  const files = (await fs.readdir(exportDir)).filter((name) => name.endsWith(".csv"));
  if (files.length !== 1) throw new Error(`expected one export file, got ${files.length}`);
  const csv = await fs.readFile(path.join(exportDir, files[0]));
  const text = csv.toString("utf8");
  if (csv.subarray(0, 3).toString("hex") !== "efbbbf") throw new Error("missing UTF-8 BOM");
  if (!text.slice(1).startsWith("timestamp,status_code,length,file_type,url\r\n")) {
    throw new Error("unexpected CSV header");
  }
  if (text.trim().split("\r\n").length !== 4) throw new Error("unexpected CSV row count");

  console.log("PACKAGED_VERIFY_OK");
  console.log(`title=${title} rows=${rowCount} csv=${path.basename(files[0])}`);
} finally {
  await app.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(exportDir, { recursive: true, force: true });
}
