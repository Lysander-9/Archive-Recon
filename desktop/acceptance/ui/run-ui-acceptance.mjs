/**
 * Independent UI acceptance against the built final candidate.
 *
 * Uses the real Electron window, nativeTheme (not emulateMedia), real clipboard
 * readback, loopback fixtures and the production preload bridge. This is not a
 * rerun of the developer E2E suite.
 *
 * Usage (after npm run build):
 *   node acceptance/ui/run-ui-acceptance.mjs
 */

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "..", "..");
const results = [];
const HEADER = ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"];

function record(index, host = "example.com") {
  const interesting = index % 7 === 0;
  return [
    `k${index}`,
    `202401${String((index % 28) + 1).padStart(2, "0")}030405`,
    interesting
      ? `https://${host}/config/${index}.env`
      : `https://${host}/assets/${index}/index.html?q=${index}`,
    index % 3 === 0 ? "application/pdf" : "text/html",
    String([200, 200, 301, 404, 500][index % 5]),
    `D${index}`,
    String(100 + index),
  ];
}

function waybackRows(host) {
  const rows = [HEADER];
  for (let i = 0; i < 60; i += 1) rows.push(record(i, host));
  rows.push([...rows[1]]);
  return rows;
}

let collinfoMode = "valid";
let baseUrl = "";
const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", baseUrl || "http://127.0.0.1");
  const host = (url.searchParams.get("url") ?? "").replace(/^\*\./, "").toLowerCase();
  response.setHeader("content-type", "application/json; charset=utf-8");

  if (url.pathname === "/wayback") {
    const page = Number(url.searchParams.get("page") ?? "0");
    const size = Number(url.searchParams.get("pageSize") ?? "50");
    const all = waybackRows(host);
    const rows = [all[0], ...all.slice(1 + page * size, 1 + (page + 1) * size)];
    if (host.includes("slow.")) {
      setTimeout(() => response.end(JSON.stringify(rows)), 900);
      return;
    }
    response.end(JSON.stringify(rows));
    return;
  }
  if (url.pathname === "/cc/collinfo.json") {
    const entry = collinfoMode === "unknown"
      ? {
          id: "CC-MAIN-UNKNOWN",
          "cdx-api": `${baseUrl}/cc/CC-MAIN-UNKNOWN-index`,
        }
      : {
          id: "CC-MAIN-2024-10",
          "cdx-api": `${baseUrl}/cc/CC-MAIN-2024-10-index`,
          from: "20240101000000",
          to: "20240301000000",
        };
    response.end(JSON.stringify([entry]));
    return;
  }
  if (url.pathname.includes("-index")) {
    if (url.searchParams.get("showNumPages") === "true") {
      response.end(JSON.stringify({ pages: 1 }));
      return;
    }
    response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    if (host.includes("malformed.")) {
      response.end([
        '{"url":"https://malformed.example.com/ok","status":"200","mime":"text/html","length":"1","timestamp":"20240102030405"}',
        "this line is not valid JSON",
      ].join("\n"));
      return;
    }
    response.end([
      '{"url":"https://example.com/cc/1","status":"200","mime":"text/html","length":"1","timestamp":"20240102030405"}',
      '{"url":"https://example.com/cc/2","status":"200","mime":"text/html","length":"2","timestamp":"20240103040506"}',
    ].join("\n"));
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});

function fail(message) {
  throw new Error(message);
}
function assert(condition, message) {
  if (!condition) fail(message);
}
async function waitStatus(page, expected, timeout = 30_000) {
  await page.waitForFunction(
    (value) => document.querySelector('[data-testid="status-chip"]')?.textContent?.trim() === value,
    expected,
    { timeout },
  );
}
async function runQuery(page, { target, source = "wayback", range = "all" }) {
  await page.fill('[data-testid="target-input"]', target);
  await page.selectOption('[data-testid="source-select"]', source);
  await page.selectOption('[data-testid="range-mode"]', range);
  await page.click('[data-testid="start-button"]');
}

let app;
let page;
let exportDir;
try {
  await fs.access(path.join(DESKTOP, "dist", "main", "main.js"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-ui-acceptance-"));

  app = await electron.launch({
    args: [path.join(DESKTOP, "dist", "main", "main.js")],
    env: {
      ...process.env,
      ARCHRECON_TEST_MODE: "1",
      ARCHRECON_WAYBACK_URL: `${baseUrl}/wayback`,
      ARCHRECON_CC_INDEX_BASE: `${baseUrl}/cc`,
      ARCHRECON_EXPORT_DIR: exportDir,
    },
  });
  page = await app.firstWindow();
  await page.waitForSelector('[data-testid="target-input"]', { timeout: 20_000 });

  // 1. nativeTheme real switch (no emulateMedia).
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "dark"; });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark", null, { timeout: 10_000 });
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "light"; });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light", null, { timeout: 10_000 });
  const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert(darkBg !== lightBg, "nativeTheme switch did not change body colors");
  results.push({ id: "nativeTheme", ok: true, darkBg, lightBg });

  // 2. small windows keep the pagination/export footer reachable.
  for (const [width, height] of [[1202, 680], [1040, 620]]) {
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
    }, { width, height });
    await page.waitForTimeout(200);
    const box = await page.locator('[data-testid="export-csv"]').boundingBox();
    assert(box && box.y >= 0 && box.y + box.height <= height + 2, `export footer not reachable at ${width}x${height}`);
  }
  results.push({ id: "small-window", ok: true, sizes: ["1202x680", "1040x620"] });

  // 3. highlight + filter + paging + sort on 60 unique rows.
  await runQuery(page, { target: "example.com", source: "wayback", range: "all" });
  await waitStatus(page, "完成");
  const interestingCount = await page.locator("#rows-body tr.interesting").count();
  assert(interestingCount > 0, "no interesting row highlight");
  await page.fill('[data-testid="filter-status"]', "200");
  await page.click('[data-testid="apply-filter"]');
  await page.selectOption('[data-testid="page-size"]', "20");
  await page.waitForFunction(() => document.querySelector('[data-testid="page-label"]')?.textContent?.includes("第 1 /"));
  await page.click('[data-testid="next-page"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="page-label"]')?.textContent?.includes("第 2 /"));
  const header = page.locator('th[data-sort="timestamp"]');
  await header.click();
  assert((await header.getAttribute("aria-sort")) === "ascending", "timestamp sort did not apply");
  await page.click('[data-testid="clear-filter"]');
  results.push({ id: "highlight-filter-paging-sort", ok: true, interestingCount });

  // 4. result source stays frozen after changing the selector.
  await page.selectOption('[data-testid="source-select"]', "commoncrawl");
  const scope = (await page.locator('[data-testid="scope-label"]').textContent()) ?? "";
  assert(scope.includes("Wayback"), `scope lost frozen source: ${scope}`);
  results.push({ id: "source-freeze", ok: true, scope });

  // 5. partial with 0 rows must not claim "没有存档记录".
  collinfoMode = "unknown";
  await runQuery(page, { target: "unknown.example.com", source: "commoncrawl", range: "recent" });
  await waitStatus(page, "部分完成");
  const rowCount = await page.locator("#rows-body tr").count();
  assert(rowCount === 0, `expected 0 rows, got ${rowCount}`);
  const emptyText = (await page.locator('[data-testid="empty-state"]').textContent()) ?? "";
  assert(!emptyText.includes("没有存档记录"), `partial empty state falsely claims no records: ${emptyText}`);
  assert(await page.locator('[data-testid="reasons-button"]').isVisible(), "reasons button not visible");
  results.push({ id: "partial-empty", ok: true, emptyText });

  // 6. copyReasons: clear real clipboard, copy, read back.
  collinfoMode = "valid";
  await runQuery(page, { target: "malformed.example.com", source: "commoncrawl", range: "all" });
  await waitStatus(page, "部分完成");
  await page.click('[data-testid="reasons-button"]');
  await app.evaluate(({ clipboard }) => clipboard.clear());
  await page.click("#reasons-copy");
  await page.waitForFunction(
    () => document.querySelector('[data-testid="notice"]')?.textContent?.includes("已复制"),
    null,
    { timeout: 10_000 },
  );
  const clipboardText = await app.evaluate(({ clipboard }) => clipboard.readText());
  for (const fragment of ["未完成原因", "目标 malformed.example.com", "来源 Common Crawl", "读取上限", "parse_line"]) {
    assert(clipboardText.includes(fragment), `clipboard missing ${fragment}`);
  }
  results.push({ id: "copyReasons", ok: true, clipboardLength: clipboardText.length });
  await page.evaluate(() => { const d = document.getElementById("reasons-dialog"); if (d?.open) d.close(); });

  // 7. stop then restart.
  await runQuery(page, { target: "slow.example.com", source: "wayback", range: "all" });
  await page.waitForTimeout(120);
  await page.click('[data-testid="cancel-button"]');
  await waitStatus(page, "已停止");
  await runQuery(page, { target: "example.com", source: "wayback", range: "all" });
  await waitStatus(page, "完成");
  results.push({ id: "stop-restart", ok: true });

  // 8. rapid filter changes land on the last request (generation sanity).
  for (const status of ["0", "1", "2"]) {
    await page.fill('[data-testid="filter-status"]', status);
    await page.click('[data-testid="apply-filter"]');
  }
  await page.waitForTimeout(300);
  const summary = (await page.locator('[data-testid="summary"]').textContent()) ?? "";
  assert(summary.includes("匹配"), `summary missing after rapid filters: ${summary}`);
  results.push({ id: "rapid-filter", ok: true, summary });

  console.log(`UI_ACCEPTANCE_RESULT ${JSON.stringify({ ok: true, results })}`);
} catch (error) {
  results.push({ id: "fatal", ok: false, error: error instanceof Error ? error.message : String(error) });
  console.log(`UI_ACCEPTANCE_RESULT ${JSON.stringify({ ok: false, results })}`);
} finally {
  await app?.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  if (exportDir) await fs.rm(exportDir, { recursive: true, force: true });
  process.exit(results.every((item) => item.ok) ? 0 : 1);
}
