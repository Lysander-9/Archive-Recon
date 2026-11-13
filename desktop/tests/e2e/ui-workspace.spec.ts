import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/**
 * 界面工作区与任务状态的端到端验收（独立于 desktop.spec.ts 的夹具与断言）。
 *
 * 覆盖范围：
 * - 1202×680 / 1040×620、五档字号下常驻分页与导出栏可达；
 * - 任务状态与代理/导出等提示分离；
 * - 筛选（状态码/域名/敏感路径）、排序、每页、跳页与行号连续；
 * - 部分完成时的未完成原因入口与解析丢行明细；
 * - 系统浅/深主题跟随；勾选复制；筛选无匹配的清除入口。
 *
 * 所有数据来自本地回环夹具，不访问外部目标。
 */

const desktopRoot = path.resolve(__dirname, "..", "..");

/* ------------------------------------------------------------------ */
/* 本地夹具：60 条唯一记录 + 2 条重复，另有 CC 索引含解析丢行             */
/* ------------------------------------------------------------------ */

interface Fixture {
  baseUrl: string;
  close(): Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const wayback = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"]];
  const base = Date.UTC(2024, 0, 1, 0, 0, 0);
  for (let i = 0; i < 60; i += 1) {
    const host = i % 5 === 0 ? "www.example.com" : "example.com";
    const interesting = i % 7 === 0;
    const url = interesting
      ? `https://${host}/config/${i}.env`
      : `https://${host}/assets/${i}/index.html?q=${i}`;
    const stamp = new Date(base + i * 86_400_000)
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14);
    wayback.push([
      `k${i}`,
      stamp,
      url,
      ["text/html", "application/pdf", "image/png"][i % 3],
      String([200, 200, 301, 404, 500][i % 5]),
      `D${i}`,
      String(1000 + i),
    ]);
  }
  // 两条重复 URL：用于验证“接收 > 去重”
  wayback.push([...wayback[1]]);
  wayback.push([...wayback[2]]);

  let baseUrl = "";
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", baseUrl || "http://127.0.0.1");
    response.setHeader("content-type", "application/json; charset=utf-8");

    if (url.pathname === "/wayback") {
      const page = Number(url.searchParams.get("page") ?? "0");
      const size = Number(url.searchParams.get("pageSize") ?? "50");
      const body = [wayback[0], ...wayback.slice(1 + page * size, 1 + (page + 1) * size)];
      response.end(JSON.stringify(body));
      return;
    }
    if (url.pathname === "/cc/collinfo.json") {
      response.end(
        JSON.stringify([
          {
            id: "CC-MAIN-2024-10",
            "cdx-api": `${baseUrl}/cc/CC-MAIN-2024-10-index`,
            from: "20240101000000",
            to: "20240301000000",
          },
        ]),
      );
      return;
    }
    if (url.pathname === "/cc/CC-MAIN-2024-10-index") {
      if (url.searchParams.get("showNumPages") === "true") {
        response.end(JSON.stringify({ pages: 1 }));
        return;
      }
      response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
      const lines: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        lines.push(
          JSON.stringify({
            url: `https://example.com/cc/${i}`,
            status: "200",
            mime: "text/html",
            length: String(i),
            timestamp: "20240102030405",
          }),
        );
      }
      lines.splice(3, 0, "this line is not valid JSON and must be reported");
      response.end(lines.join("\n"));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/* ------------------------------------------------------------------ */
/* 应用生命周期                                                         */
/* ------------------------------------------------------------------ */

let app: ElectronApplication;
let page: Page;
let fixture: Fixture;
let exportDir: string;

async function launch(): Promise<void> {
  app = await electron.launch({
    args: [path.join(desktopRoot, "dist", "main", "main.js")],
    env: {
      ...process.env,
      ARCHRECON_TEST_MODE: "1",
      ARCHRECON_WAYBACK_URL: `${fixture.baseUrl}/wayback`,
      ARCHRECON_CC_INDEX_BASE: `${fixture.baseUrl}/cc`,
      ARCHRECON_EXPORT_DIR: exportDir,
    },
  });
  page = await app.firstWindow();
  await page.waitForSelector('[data-testid="target-input"]');
}

async function resize(width: number, height: number): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(size.width, size.height);
  }, { width, height });
  await page.waitForTimeout(250);
}

interface LayoutFacts {
  viewport: [number, number];
  footerVisible: boolean;
  pageScroll: number;
  visibleRows: number;
  tableHeight: number;
}

// 说明：tsconfig 的 lib 只有 ES2022（无 DOM），因此页面内断言使用字符串表达式。
async function layoutFacts(): Promise<LayoutFacts> {
  const script = `(() => {
    const footer = document.querySelector(".pagination").getBoundingClientRect();
    const exportJson = document.querySelector('[data-testid="export-json"]').getBoundingClientRect();
    const wrap = document.querySelector(".table-wrap").getBoundingClientRect();
    let visibleRows = 0;
    for (const row of Array.from(document.querySelectorAll("#rows-body tr"))) {
      const box = row.getBoundingClientRect();
      if (box.top >= wrap.top - 1 && box.bottom <= wrap.bottom + 1) visibleRows += 1;
    }
    return {
      viewport: [window.innerWidth, window.innerHeight],
      footerVisible:
        footer.top >= 0 &&
        footer.bottom <= window.innerHeight + 0.5 &&
        exportJson.top >= 0 &&
        exportJson.right <= window.innerWidth + 0.5,
      pageScroll: document.documentElement.scrollHeight - window.innerHeight,
      visibleRows,
      tableHeight: Math.round(wrap.height),
    };
  })()`;
  return (await page.evaluate(script)) as LayoutFacts;
}

async function runWayback(): Promise<void> {
  await page.selectOption('[data-testid="source-select"]', "wayback");
  await page.selectOption('[data-testid="range-mode"]', "recent");
  await page.fill('[data-testid="target-input"]', "example.com");
  await page.click('[data-testid="start-button"]');
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("完成", { timeout: 30_000 });
  await expect(page.locator("#rows-body tr").first()).toBeVisible();
}

async function runCommonCrawl(): Promise<void> {
  await page.selectOption('[data-testid="source-select"]', "commoncrawl");
  await page.selectOption('[data-testid="range-mode"]', "all");
  await page.fill('[data-testid="target-input"]', "example.com");
  await page.click('[data-testid="start-button"]');
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("部分完成", {
    timeout: 30_000,
  });
  await expect(page.locator("#rows-body tr").first()).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fixture = await startFixture();
  exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-ui-e2e-"));
  await launch();
});

test.afterAll(async () => {
  try {
    await app?.close();
  } catch {
    // 最后一个用例可能已经关闭窗口
  }
  await fixture?.close();
  await fs.rm(exportDir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await page.emulateMedia({ colorScheme: "light" });
  await resize(1202, 680);
  await page.evaluate(
    "(() => { const d = document.getElementById('reasons-dialog'); if (d && d.open) d.close(); })()",
  );
});

test("常驻分页与导出栏在 1202×680、1040×620 与五档字号下均可达", async () => {
  await runWayback();

  for (const [width, height] of [
    [1202, 680],
    [1040, 620],
  ] as const) {
    await resize(width, height);
    for (const font of ["small", "default", "medium", "large", "xlarge"]) {
      await page.selectOption('[data-testid="font-size"]', font);
      await page.waitForTimeout(180);
      const facts = await layoutFacts();
      expect(
        facts.footerVisible,
        `${width}x${height} 字号=${font} 时分页/导出栏不可达`,
      ).toBe(true);
      expect(facts.pageScroll, "页面不应出现整体滚动").toBeLessThanOrEqual(1);
      expect(facts.visibleRows, `${width}x${height} 字号=${font} 时可见行过少`).toBeGreaterThanOrEqual(5);
    }
  }

  await page.selectOption('[data-testid="font-size"]', "default");
});

test("Common Crawl 部分完成：原因入口与页脚同时可见", async () => {
  await runCommonCrawl();

  for (const [width, height] of [
    [1202, 680],
    [1040, 620],
  ] as const) {
    await resize(width, height);
    await expect(page.locator('[data-testid="reasons-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="reasons-button"]')).toHaveText(/\d+ 项未完成/);
    expect((await layoutFacts()).footerVisible).toBe(true);
  }
});

test("原因面板列出解析丢行明细", async () => {
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("部分完成");
  await page.click('[data-testid="reasons-button"]');
  await expect(page.locator("#reasons-dialog")).toBeVisible();
  await expect(page.locator('[data-testid="reasons-list"]')).toContainText("响应解析丢行");
  await expect(page.locator('[data-testid="reasons-list"]')).toContainText("无法解析");
  await expect(page.locator("#reasons-scope")).toContainText("目标 example.com");
  await page.keyboard.press("Escape");
  await expect(page.locator("#reasons-dialog")).toBeHidden();
});

test("终态状态块与结果行同帧更新", async () => {
  await page.selectOption('[data-testid="source-select"]', "wayback");
  await page.selectOption('[data-testid="range-mode"]', "recent");
  await page.fill('[data-testid="target-input"]', "example.com");
  await page.click('[data-testid="start-button"]');
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("完成", { timeout: 30_000 });
  // 状态块与最终视图一起提交：此刻表格不应还是空的（回归：终态先于视图到达）
  const rows = await page.locator("#rows-body tr").count();
  expect(rows).toBeGreaterThan(0);
  await expect(page.locator('[data-testid="page-label"]')).toContainText("/");
});

test("任务状态与复制/导出提示互不覆盖", async () => {
  await runWayback();
  const taskBefore = await page.locator('[data-testid="task-text"]').textContent();
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("完成");

  await page.click('[data-testid="copy-url"]');
  await expect(page.locator('[data-testid="notice"]')).toContainText(/已复制 \d+ 条 URL/);
  expect(await page.locator('[data-testid="task-text"]').textContent()).toBe(taskBefore);
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("完成");

  await page.click('[data-testid="export-csv"]');
  await expect(page.locator('[data-testid="notice"]')).toContainText(/已导出 \d+ 条记录/);
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("完成");
  // 代理信息属于任务口径，不占用任务状态文本
  await expect(page.locator('[data-testid="scope-label"]')).toContainText("代理 直连");
});

test("筛选未应用提示、应用生效与清除恢复", async () => {
  await runWayback();
  const initial = await page.locator("#rows-body tr").count();

  await page.fill('[data-testid="filter-url"]', "?q=43");
  await expect(page.locator('[data-testid="filter-pending"]')).toBeVisible();
  await page.click('[data-testid="apply-filter"]');
  await expect(page.locator('[data-testid="filter-pending"]')).toBeHidden();
  await expect(page.locator('[data-testid="summary"]')).toContainText("匹配 1 / 去重 60 / 接收 62");

  const urls = await page.locator("#rows-body td.url").allTextContents();
  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain("q=43");

  await page.click('[data-testid="clear-filter"]');
  await expect(page.locator("#rows-body tr")).toHaveCount(initial);
});

test("域名筛选与敏感路径筛选（P1）", async () => {
  await runWayback();

  await page.fill('[data-testid="filter-domain"]', "www.example.com");
  await page.click('[data-testid="apply-filter"]');
  await expect(page.locator('[data-testid="summary"]')).toContainText("匹配 12 /");
  const wwwUrls = await page.locator("#rows-body td.url").allTextContents();
  expect(wwwUrls.length).toBe(12);
  expect(wwwUrls.every((url) => url.startsWith("https://www.example.com/"))).toBe(true);

  await page.click('[data-testid="clear-filter"]');
  await page.check('[data-testid="filter-interesting"]');
  await expect(page.locator('[data-testid="summary"]')).toContainText(/匹配 9 \/ 去重 60 \/ 接收 62/);
  const interesting = await page.locator("#rows-body td.url").allTextContents();
  expect(interesting.every((url) => url.endsWith(".env"))).toBe(true);

  await page.uncheck('[data-testid="filter-interesting"]');
  await expect(page.locator("#rows-body tr").first()).toBeVisible();
});

test("排序、每页切换、跳页夹取与跨页行号", async () => {
  await runWayback();

  const header = page.locator('th[data-sort="timestamp"]');
  await header.click();
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  await header.click();
  await expect(header).toHaveAttribute("aria-sort", "descending");

  await page.selectOption('[data-testid="page-size"]', "20");
  await expect(page.locator('[data-testid="page-label"]')).toHaveText("第 1 / 3 页");

  await page.click('[data-testid="next-page"]');
  await expect(page.locator('[data-testid="page-label"]')).toHaveText("第 2 / 3 页");
  await expect(page.locator("#rows-body tr").first().locator("td.rownum-col")).toHaveText("21");

  await page.fill('[data-testid="page-jump"]', "99");
  await page.click('[data-testid="page-jump-go"]');
  await expect(page.locator('[data-testid="notice"]')).toContainText("页码范围");
  await expect(page.locator('[data-testid="page-label"]')).toHaveText("第 3 / 3 页");

  await page.fill('[data-testid="page-jump"]', "1");
  await page.click('[data-testid="page-jump-go"]');
  await expect(page.locator('[data-testid="page-label"]')).toHaveText("第 1 / 3 页");
  await expect(page.locator("#rows-body tr").first().locator("td.rownum-col")).toHaveText("1");

  await page.selectOption('[data-testid="page-size"]', "50");
  await page.fill('[data-testid="filter-status"]', "200");
  await page.click('[data-testid="apply-filter"]');
  await expect(page.locator('[data-testid="page-label"]')).toHaveText("第 1 / 1 页");
  await expect(page.locator("#rows-body tr").first().locator("td.rownum-col")).toHaveText("1");
  await page.click('[data-testid="clear-filter"]');
});

test("字号只改变表格，不移动固定区", async () => {
  await runWayback();
  const footerTop = await page
    .locator(".pagination")
    .boundingBox()
    .then((box) => Math.round(box ? box.y : -1));
  const fontSizeDefault = (await page.evaluate(
    "getComputedStyle(document.querySelector('table')).fontSize",
  )) as string;

  await page.selectOption('[data-testid="font-size"]', "xlarge");
  await page.waitForTimeout(200);
  const footerTopLarge = await page
    .locator(".pagination")
    .boundingBox()
    .then((box) => Math.round(box ? box.y : -1));
  const fontSizeLarge = (await page.evaluate(
    "getComputedStyle(document.querySelector('table')).fontSize",
  )) as string;

  expect(Math.abs(footerTopLarge - footerTop)).toBeLessThanOrEqual(1);
  expect(fontSizeLarge).not.toBe(fontSizeDefault);
  expect((await layoutFacts()).footerVisible).toBe(true);
  await page.selectOption('[data-testid="font-size"]', "default");
});

test("浅色/深色主题跟随系统偏好", async () => {
  await runWayback();

  const readTheme = async (): Promise<{ body: string; surface: string; text: string }> =>
    (await page.evaluate(`(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      surface: getComputedStyle(document.querySelector(".workspace")).backgroundColor,
      text: getComputedStyle(document.body).color,
    }))()`)) as { body: string; surface: string; text: string };

  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(160);
  const light = await readTheme();

  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(160);
  const dark = await readTheme();

  expect(light.body).not.toBe(dark.body);
  expect(light.surface).not.toBe(dark.surface);
  expect(light.text).not.toBe(dark.text);
  expect(dark.body).toBe("rgb(14, 21, 35)");
  expect(dark.surface).toBe("rgb(23, 32, 51)");
  expect((await layoutFacts()).footerVisible).toBe(true);
});

test("勾选行复制仅包含所选，全选覆盖当前页", async () => {
  await runWayback();

  const boxes = page.locator("#rows-body input[type=checkbox]");
  await boxes.nth(0).check();
  await boxes.nth(2).check();
  await page.click('[data-testid="copy-url"]');
  await expect(page.locator('[data-testid="notice"]')).toContainText("已复制 2 条 URL");

  await page.check("#select-all");
  await page.click('[data-testid="copy-url"]');
  await expect(page.locator('[data-testid="notice"]')).toContainText(/已复制 (50|60) 条 URL/);
});

test("筛选无匹配时给出清除入口", async () => {
  await runWayback();
  await page.fill('[data-testid="filter-url"]', "no-such-keyword");
  await page.click('[data-testid="apply-filter"]');
  await expect(page.locator('[data-testid="empty-state"]')).toBeVisible();
  await expect(page.locator("#empty-title")).toHaveText("当前筛选没有匹配结果");
  await page.click("#empty-action");
  await expect(page.locator("#rows-body tr").first()).toBeVisible();
});
