import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { startFixtureServer, type FixtureServer } from "../support/fixture-server";

/**
 * 首次查询就失败（还没有任何旧任务）时的界面回归。
 *
 * 覆盖：
 * - 非法目标：主进程在创建任务前拒绝，界面必须回到“就绪 + 可重试”，不残留“准备中”；
 * - 代理在创建 session 前失败（SOCKS 认证不受支持）：同样回到就绪空态；
 * - 两处都通过真实 IPC 断言失败尝试没有产生任何 job 事件（无会话/任务运行），
 *   并且随后直接在空态里点“重新查询”即可成功。
 */

const desktopRoot = path.resolve(__dirname, "..", "..");

let app: ElectronApplication;
let page: Page;
let server: FixtureServer;
let exportDir: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  server = await startFixtureServer();
  exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-first-fail-"));
  app = await electron.launch({
    args: [path.join(desktopRoot, "dist", "main", "main.js")],
    env: {
      ...process.env,
      ARCHRECON_TEST_MODE: "1",
      ARCHRECON_WAYBACK_URL: `${server.baseUrl}/wayback`,
      ARCHRECON_CC_INDEX_BASE: `${server.baseUrl}/cc`,
      ARCHRECON_EXPORT_DIR: exportDir,
    },
  });
  page = await app.firstWindow();
  await page.waitForSelector('[data-testid="target-input"]');
  await page.evaluate(
    `(() => {
      window.__jobEvents = [];
      window.archiveRecon.onJobEvent((event) => window.__jobEvents.push(event));
    })()`,
  );
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await server?.close();
  await fs.rm(exportDir, { recursive: true, force: true });
});

async function expectNoPreparingState(): Promise<void> {
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("就绪");
  await expect(page.locator('[data-testid="task-text"]')).toHaveText("输入目标域名后开始查询");
  await expect(page.locator('[data-testid="task-text"]')).not.toContainText("准备中");
  await expect(page.locator("#empty-title")).toHaveText("查询未能开始");
  await expect(page.locator("#empty-title")).not.toContainText("准备中");
  await expect(page.locator("#empty-action")).toHaveText("重新查询");
  await expect(page.locator("#empty-action")).toBeVisible();
  await expect(page.locator('[data-testid="start-button"]')).toBeEnabled();
  await expect(page.locator('[data-testid="cancel-button"]')).toBeDisabled();
}

async function jobEventCount(): Promise<number> {
  return (await page.evaluate("window.__jobEvents.length")) as number;
}

test("首次代理失败（创建 session 前）回到就绪空态且无会话事件", async () => {
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("就绪");
  await page.fill('[data-testid="target-input"]', "example.com");
  await page.selectOption('[data-testid="proxy-mode"]', "fixed");
  await page.fill('[data-testid="proxy-server"]', "socks5://user:pass@127.0.0.1:1080");
  await page.click('[data-testid="start-button"]');

  await expect(page.locator('[data-testid="notice"]')).toContainText("PROXY");
  await expect(page.locator('[data-testid="notice"]')).toContainText("SOCKS");
  await expectNoPreparingState();

  // 失败发生在创建任务/session 之前：真实 IPC 不应产生任何 job 事件
  await page.waitForTimeout(300);
  expect(await jobEventCount()).toBe(0);

  await page.selectOption('[data-testid="proxy-mode"]', "direct");
});

test("首次非法目标回到就绪空态，并可从空态直接重试成功", async () => {
  await page.fill('[data-testid="target-input"]', "http://bad.example.com/path");
  await page.click('[data-testid="start-button"]');

  await expect(page.locator('[data-testid="notice"]')).toContainText("INVALID_INPUT");
  await expectNoPreparingState();

  await page.waitForTimeout(300);
  expect(await jobEventCount()).toBe(0);

  // 修正目标后直接从“重新查询”按钮重试，任务应正常建立
  await page.fill('[data-testid="target-input"]', "example.com");
  await page.click("#empty-action");
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("完成", { timeout: 30_000 });
  await expect(page.locator("#rows-body tr")).toHaveCount(3);
  expect(await jobEventCount()).toBeGreaterThan(0);
});
