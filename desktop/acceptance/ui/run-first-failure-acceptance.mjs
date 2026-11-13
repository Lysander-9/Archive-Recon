/**
 * Independent first-start failure probe for the 5a548b3 increment.
 *
 * Real Electron window + production bridge: the first query fails before a job
 * exists (invalid target / proxy rejected during session creation). The UI must
 * return to idle, keep the error, expose retry, and not leave a "preparing"
 * empty state. Existing-task failure must still roll back the previous result.
 *
 * Usage (after npm run build): node acceptance/ui/run-first-failure-acceptance.mjs
 */

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "..", "..");
const results = [];

const rows = [
  ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
  ["k1", "20240102030405", "https://example.com/a", "text/html", "200", "D1", "10"],
  ["k2", "20240103040506", "https://example.com/b", "text/html", "200", "D2", "20"],
  ["k3", "20240104050607", "https://example.com/c", "text/html", "200", "D3", "30"],
];

let baseUrl = "";
const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", baseUrl || "http://127.0.0.1");
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (url.pathname === "/wayback") {
    const page = Number(url.searchParams.get("page") ?? "0");
    response.end(JSON.stringify(page === 0 ? rows : [rows[0]]));
    return;
  }
  if (url.pathname === "/cc/collinfo.json") {
    response.end("[]");
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function waitStatus(page, expected, timeout = 20_000) {
  await page.waitForFunction(
    (value) => document.querySelector('[data-testid="status-chip"]')?.textContent?.trim() === value,
    expected,
    { timeout },
  );
}
async function launch() {
  const app = await electron.launch({
    args: [path.join(DESKTOP, "dist", "main", "main.js")],
    env: {
      ...process.env,
      ARCHRECON_TEST_MODE: "1",
      ARCHRECON_WAYBACK_URL: `${baseUrl}/wayback`,
      ARCHRECON_CC_INDEX_BASE: `${baseUrl}/cc`,
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="target-input"]', { timeout: 20_000 });
  await page.evaluate(() => {
    window.__failureEvents = 0;
    window.archiveRecon.onJobEvent(() => { window.__failureEvents += 1; });
  });
  return { app, page };
}
async function close(app) {
  await app?.close().catch(() => undefined);
}

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // A. First start with an invalid target, then retry; then existing-task rollback.
  {
    const { app, page } = await launch();
    try {
      await page.fill('[data-testid="target-input"]', "http://bad.example.com/path");
      await page.selectOption('[data-testid="source-select"]', "wayback");
      await page.selectOption('[data-testid="range-mode"]', "all");
      await page.click('[data-testid="start-button"]');
      await waitStatus(page, "就绪");
      await page.waitForTimeout(300);
      assert((await page.evaluate(() => window.__failureEvents)) === 0, "failed start emitted job events");
      const notice = (await page.locator('[data-testid="notice"]').textContent()) ?? "";
      assert(notice.includes("INVALID_INPUT"), `notice missing INVALID_INPUT: ${notice}`);
      const emptyTitle = (await page.locator("#empty-title").textContent()) ?? "";
      assert(emptyTitle === "查询未能开始", `unexpected empty title: ${emptyTitle}`);
      assert(!(await page.locator("#empty-detail").textContent())?.includes("准备中"), "preparing detail leaked");
      assert(await page.locator("#empty-action").isVisible(), "retry action not visible");
      assert(await page.locator('[data-testid="start-button"]').isEnabled(), "start button stayed disabled");
      assert(await page.locator('[data-testid="cancel-button"]').isDisabled(), "stop button enabled after failure");
      const taskText = (await page.locator('[data-testid="task-text"]').textContent()) ?? "";
      assert(taskText.includes("输入目标域名"), `task text not reset: ${taskText}`);

      await page.fill('[data-testid="target-input"]', "example.com");
      await page.click("#empty-action");
      await waitStatus(page, "完成");
      assert((await page.locator("#rows-body tr").count()) === 3, "retry did not return three rows");
      assert((await page.evaluate(() => window.__failureEvents)) > 0, "successful retry emitted no events");

      // Existing-task failure must keep the previous completed result.
      await page.fill('[data-testid="target-input"]', "http://bad.example.com/path");
      await page.click('[data-testid="start-button"]');
      await waitStatus(page, "完成");
      assert((await page.locator("#rows-body tr").count()) === 3, "previous rows were lost on failure");
      const rollbackNotice = (await page.locator('[data-testid="notice"]').textContent()) ?? "";
      assert(rollbackNotice.includes("INVALID_INPUT"), "rollback did not keep the error notice");
      results.push({ id: "first-invalid-then-retry-and-rollback", ok: true });
    } finally {
      await close(app);
    }
  }

  // B. First start fails during proxy/session creation, then retry succeeds.
  {
    const { app, page } = await launch();
    try {
      await page.fill('[data-testid="target-input"]', "example.com");
      await page.selectOption('[data-testid="source-select"]', "wayback");
      await page.selectOption('[data-testid="range-mode"]', "all");
      await page.selectOption('[data-testid="proxy-mode"]', "fixed");
      await page.fill('[data-testid="proxy-server"]', "socks5://user:pass@127.0.0.1:1080");
      await page.click('[data-testid="start-button"]');
      await waitStatus(page, "就绪");
      await page.waitForTimeout(300);
      assert((await page.evaluate(() => window.__failureEvents)) === 0, "proxy failure emitted job events");
      const notice = (await page.locator('[data-testid="notice"]').textContent()) ?? "";
      assert(notice.includes("PROXY") || notice.includes("SOCKS"), `proxy error missing: ${notice}`);
      assert((await page.locator("#empty-title").textContent()) === "查询未能开始", "proxy failure empty state wrong");
      assert(await page.locator("#empty-action").isVisible(), "proxy retry action missing");
      assert(await page.locator('[data-testid="start-button"]').isEnabled(), "start stayed disabled after proxy failure");
      assert(await page.locator('[data-testid="cancel-button"]').isDisabled(), "stop enabled after proxy failure");

      await page.selectOption('[data-testid="proxy-mode"]', "direct");
      await page.click("#empty-action");
      await waitStatus(page, "完成");
      assert((await page.locator("#rows-body tr").count()) === 3, "proxy retry did not return three rows");
      results.push({ id: "first-proxy-failure-then-retry", ok: true });
    } finally {
      await close(app);
    }
  }

  console.log(`FIRST_FAILURE_ACCEPTANCE_RESULT ${JSON.stringify({ ok: true, results })}`);
} catch (error) {
  results.push({ id: "fatal", ok: false, error: error instanceof Error ? error.message : String(error) });
  console.log(`FIRST_FAILURE_ACCEPTANCE_RESULT ${JSON.stringify({ ok: false, results })}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  process.exit(results.every((item) => item.ok) ? 0 : 1);
}
