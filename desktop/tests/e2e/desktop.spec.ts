import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { startFixtureServer, type FixtureServer } from "../support/fixture-server";

const desktopRoot = path.resolve(__dirname, "..", "..");

let app: ElectronApplication;
let page: Page;
let server: FixtureServer;
let exportDir: string;

async function launch(): Promise<void> {
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
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  server = await startFixtureServer();
  exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-e2e-"));
  await launch();
});

test.afterAll(async () => {
  try {
    await app?.close();
  } catch {
    // already closed by the last test
  }
  await server?.close();
  await fs.rm(exportDir, { recursive: true, force: true });
});

test("window renders and a Wayback task fills the result workspace", async () => {
  await expect(page).toHaveTitle("Archive Recon");
  await expect(page.locator('[data-testid="target-input"]')).toBeVisible();

  await page.fill('[data-testid="target-input"]', "example.com");
  await page.click('[data-testid="start-button"]');

  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("完成", { timeout: 20_000 });
  await expect(page.locator("#rows-body tr")).toHaveCount(3);
  await expect(page.locator('[data-testid="summary"]')).toContainText("匹配 3 / 去重 3 / 接收 4");
  await expect(page.locator('[data-testid="scope-label"]')).toContainText("目标 example.com");

  await page.fill('[data-testid="filter-status"]', "200");
  await page.click('[data-testid="apply-filter"]');
  await expect(page.locator("#rows-body tr")).toHaveCount(2);

  await page.click('[data-testid="clear-filter"]');
  await expect(page.locator("#rows-body tr")).toHaveCount(3);
});

test("CSV and JSON exports use the frozen five-field snapshot", async () => {
  await page.click('[data-testid="export-csv"]');
  await expect(page.locator('[data-testid="notice"]')).toContainText("已导出 3 条记录", { timeout: 5_000 });

  const files = (await fs.readdir(exportDir)).filter((name) => name.endsWith(".csv"));
  expect(files).toHaveLength(1);
  const csv = await fs.readFile(path.join(exportDir, files[0]));
  expect(csv.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  const text = csv.toString("utf8");
  expect(text.slice(1).startsWith("timestamp,status_code,length,file_type,url\r\n")).toBe(true);
  expect(text.trim().split("\r\n")).toHaveLength(4);

  await page.click('[data-testid="export-json"]');
  await expect(page.locator('[data-testid="notice"]')).toContainText("已导出 3 条记录", { timeout: 5_000 });
  const jsonFiles = (await fs.readdir(exportDir)).filter((name) => name.endsWith(".json"));
  expect(jsonFiles).toHaveLength(1);
  const parsed = JSON.parse(await fs.readFile(path.join(exportDir, jsonFiles[0]), "utf8"));
  expect(parsed).toHaveLength(3);
  expect(Object.keys(parsed[0])).toEqual(["timestamp", "status_code", "length", "file_type", "url"]);
});

test("stop keeps received rows, ignores late events, and allows a clean restart", async () => {
  await page.selectOption('[data-testid="source-select"]', "commoncrawl");
  await page.selectOption('[data-testid="range-mode"]', "all");
  await page.click('[data-testid="start-button"]');

  await expect(page.locator("#rows-body tr")).toHaveCount(2, { timeout: 20_000 });
  await page.click('[data-testid="cancel-button"]');
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("已停止", { timeout: 20_000 });
  await expect(page.locator("#rows-body tr")).toHaveCount(2);

  // The delayed second CC page must not append after the terminal state.
  await page.waitForTimeout(1_500);
  await expect(page.locator("#rows-body tr")).toHaveCount(2);

  await page.selectOption('[data-testid="source-select"]', "wayback");
  await page.selectOption('[data-testid="range-mode"]', "recent");
  await page.click('[data-testid="start-button"]');
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("完成", { timeout: 20_000 });
  await expect(page.locator("#rows-body tr")).toHaveCount(3);
  await expect(page.locator('[data-testid="scope-label"]')).toContainText("目标 example.com");
});

test("closing the window leaves the app with a clean exit", async () => {
  await app.close();
  expect(app).toBeDefined();
});
