import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";

import { startFixtureServer, type FixtureServer } from "../support/fixture-server";

const desktopRoot = path.resolve(__dirname, "..", "..");

let app: ElectronApplication;
let page: Page;
let server: FixtureServer;

test.beforeAll(async () => {
  server = await startFixtureServer();
  app = await electron.launch({
    args: [path.join(desktopRoot, "dist", "main", "main.js")],
    env: {
      ...process.env,
      ARCHRECON_TEST_MODE: "1",
      ARCHRECON_CC_INDEX_BASE: `${server.baseUrl}/cc`,
      ARCHRECON_WAYBACK_URL: `${server.baseUrl}/wayback`,
    },
  });
  page = await app.firstWindow();
  await page.waitForSelector('[data-testid="target-input"]');
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await server?.close();
});

test("copyReasons writes the frozen scope and user-facing reasons to the real clipboard", async () => {
  await app.evaluate(({ clipboard }) => clipboard.clear());

  await page.fill('[data-testid="target-input"]', "example.com");
  await page.selectOption('[data-testid="source-select"]', "commoncrawl");
  await page.selectOption('[data-testid="range-mode"]', "all");
  await page.click('[data-testid="start-button"]');
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("部分完成", { timeout: 20_000 });

  const outcome = await page.evaluate(async () => {
    const bridge = (globalThis as unknown as { archiveRecon: any }).archiveRecon;
    const view = await bridge.getView({
      jobId: 1,
      source: "commoncrawl",
      filter: { status: "", fileType: "", urlKeyword: "", domain: "", interestingOnly: false },
      sort: { key: null, reverse: false },
      pageIndex: 0,
      pageSize: 50,
    });
    if (!view.ok) return { error: view.error };
    const copied = await bridge.copyReasons({
      jobId: 1,
      source: "commoncrawl",
      revision: view.value.revision,
    });
    const stale = await bridge.copyReasons({
      jobId: 1,
      source: "commoncrawl",
      revision: view.value.revision - 1,
    });
    return { copied, staleCode: stale.ok ? null : stale.error.code };
  });

  expect(outcome.copied?.ok).toBe(true);
  expect(outcome.staleCode).toBe("STALE_VIEW");

  const clipboardText = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(clipboardText).toContain("未完成原因");
  expect(clipboardText).toContain("目标 example.com");
  expect(clipboardText).toContain("来源 Common Crawl");
  expect(clipboardText).toContain("时间范围");
  expect(clipboardText).toContain("读取上限");
  expect(clipboardText).toContain("parse_line");
  expect(clipboardText).toContain("解析跳过");
});
