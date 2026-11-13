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
      const host = (url.searchParams.get("url") ?? "").toLowerCase();
      const page = Number(url.searchParams.get("page") ?? "0");
      const size = Number(url.searchParams.get("pageSize") ?? "50");
      // 慢速目标：用于验证“立即准备态”与失败回滚
      const delay = host.includes("slow.example.com") ? 900 : 0;
      // 空结果目标：确实没有存档记录
      const rows = host.includes("empty.example.com")
        ? [wayback[0]]
        : [wayback[0], ...wayback.slice(1 + page * size, 1 + (page + 1) * size)];
      setTimeout(() => response.end(JSON.stringify(rows)), delay);
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
      const host = (url.searchParams.get("url") ?? "").toLowerCase();
      const slowCancel = host.includes("slowcc.example.com");
      const emptyHost = host.includes("empty.example.com");
      if (url.searchParams.get("showNumPages") === "true") {
        response.end(JSON.stringify({ pages: slowCancel ? 3 : 1 }));
        return;
      }
      response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
      if (emptyHost) {
        // 只有解析失败行：0 条有效记录 + parse_line 原因
        response.end("not-json-line-one\nnot-json-line-two");
        return;
      }
      const page = Number(url.searchParams.get("page") ?? "0");
      if (slowCancel && page > 0) {
        setTimeout(() => response.end(""), 1_500);
        return;
      }
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


/* ------------------------------------------------------------------ */
/* 颜色对比度工具（真实窗口计算样式，非主题验收）                          */
/* ------------------------------------------------------------------ */

function parseRgb(value: string): [number, number, number] {
  const match = /rgba?\(([^)]+)\)/.exec(value);
  if (!match) throw new Error(`无法解析颜色: ${value}`);
  const parts = match[1].split(",").map((item) => Number.parseFloat(item.trim()));
  return [parts[0], parts[1], parts[2]];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (raw: number): number => {
    const value = raw / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(parseRgb(foreground));
  const bg = relativeLuminance(parseRgb(background));
  const light = Math.max(fg, bg);
  const dark = Math.min(fg, bg);
  return (light + 0.05) / (dark + 0.05);
}

async function chipContrast(): Promise<number> {
  const colors = (await page.evaluate(
    `(() => {
      const style = getComputedStyle(document.querySelector('[data-testid="status-chip"]'));
      return [style.color, style.backgroundColor];
    })()`,
  )) as [string, string];
  return contrastRatio(colors[0], colors[1]);
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

  await page.locator("#rows-body input[type=checkbox]").first().check();
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

test("结果头显示来源，域名提示标注当前页", async () => {
  await runWayback();
  await expect(page.locator('[data-testid="scope-label"]')).toContainText("来源 Wayback Machine");
  await expect(page.locator('[data-testid="scope-label"]')).toContainText("目标 example.com");
  const placeholder = await page.getAttribute('[data-testid="filter-domain"]', "placeholder");
  expect(placeholder ?? "").toContain("当前页");
});

test("await 前立即进入准备态并清零摘要，失败回滚上一次任务", async () => {
  await runWayback();
  await expect(page.locator('[data-testid="summary"]')).toContainText("匹配 60 / 去重 60 / 接收 62");

  await page.fill('[data-testid="target-input"]', "slow.example.com");
  await page.click('[data-testid="start-button"]');
  // 900ms 夹具延迟内必须已经是准备/查询态、摘要清零、开始按钮禁用
  await expect(page.locator('[data-testid="summary"]')).toHaveText("匹配 0 / 去重 0 / 接收 0");
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText(/准备中|查询中/);
  await expect(page.locator('[data-testid="start-button"]')).toBeDisabled();
  await expect(page.locator("#rows-body tr")).toHaveCount(0);

  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("完成", { timeout: 30_000 });
  await expect(page.locator('[data-testid="summary"]')).toContainText("匹配 60 / 去重 60 / 接收 62");

  // 无效目标：await 失败后回滚到上一次终态与结果，按钮恢复可用
  await page.fill('[data-testid="target-input"]', "http://bad.example.com/path");
  await page.click('[data-testid="start-button"]');
  await expect(page.locator('[data-testid="notice"]')).toContainText("INVALID_INPUT");
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("完成", { timeout: 15_000 });
  await expect(page.locator('[data-testid="start-button"]')).toBeEnabled();
  await expect(page.locator("#rows-body tr").first()).toBeVisible();
});

test("取消后不残留停止中，终态以任务状态为准", async () => {
  await page.selectOption('[data-testid="source-select"]', "commoncrawl");
  await page.selectOption('[data-testid="range-mode"]', "all");
  await page.fill('[data-testid="target-input"]', "slowcc.example.com");
  await page.click('[data-testid="start-button"]');

  await expect(page.locator("#rows-body tr")).toHaveCount(20, { timeout: 30_000 });
  // 只有仍可停止时才点击，避免任务已自然结束导致点击等待禁用按钮
  await expect(page.locator('[data-testid="cancel-button"]')).toBeEnabled();
  await page.click('[data-testid="cancel-button"]');

  await expect(page.locator('[data-testid="status-chip"]')).toHaveText(/已停止|部分完成|完成/, {
    timeout: 30_000,
  });
  await expect(page.locator('[data-testid="status-chip"]')).not.toHaveText("停止中");
  await expect(page.locator('[data-testid="task-text"]')).not.toContainText("停止中");
  await expect(page.locator("#rows-body tr")).toHaveCount(20);
  await expect(page.locator('[data-testid="cancel-button"]')).toBeDisabled();
});

test("真实剪贴板：未勾选先提示选择，勾选后只复制所选 URL", async () => {
  await runWayback();
  await app.evaluate(({ clipboard }) => clipboard.writeText("SENTINEL"));

  await page.click('[data-testid="copy-url"]');
  await expect(page.locator('[data-testid="notice"]')).toContainText("请先勾选");
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("SENTINEL");

  const boxes = page.locator("#rows-body input[type=checkbox]");
  await boxes.nth(1).check();
  await boxes.nth(3).check();
  const expected = (await page.evaluate(
    `Array.from(document.querySelectorAll("#rows-body tr.selected td.url")).map((node) => node.textContent).join("\\r\\n")`,
  )) as string;
  expect(expected.split("\r\n")).toHaveLength(2);

  await page.click('[data-testid="copy-url"]');
  await expect(page.locator('[data-testid="notice"]')).toContainText("已复制 2 条 URL");
  const clipboardText = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(clipboardText).toBe(expected);
});

test("取不到记录但存在未完成原因时空态不宣称没有存档，并提供原因入口", async () => {
  await page.selectOption('[data-testid="source-select"]', "commoncrawl");
  await page.selectOption('[data-testid="range-mode"]', "all");
  await page.fill('[data-testid="target-input"]', "empty.example.com");
  await page.click('[data-testid="start-button"]');

  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("部分完成", { timeout: 30_000 });
  await expect(page.locator("#empty-title")).toHaveText("未取得可用记录");
  await expect(page.locator("#empty-title")).not.toContainText("没有存档");
  await expect(page.locator('[data-testid="reasons-button"]')).toBeVisible();

  await expect(page.locator("#empty-action")).toHaveText("查看原因");
  await page.click("#empty-action");
  await expect(page.locator("#reasons-dialog")).toBeVisible();
  await expect(page.locator("#reasons-list")).toContainText("响应解析丢行");
  await page.keyboard.press("Escape");
});

test("原因摘要复制在通道交付前不提示成功", async () => {
  await page.selectOption('[data-testid="source-select"]', "commoncrawl");
  await page.selectOption('[data-testid="range-mode"]', "all");
  await page.fill('[data-testid="target-input"]', "empty.example.com");
  await page.click('[data-testid="start-button"]');
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("部分完成", { timeout: 30_000 });

  await app.evaluate(({ clipboard }) => clipboard.writeText("SENTINEL"));
  await page.click('[data-testid="reasons-button"]');
  await expect(page.locator("#reasons-dialog")).toBeVisible();
  await page.click("#reasons-copy");

  await expect(page.locator('[data-testid="notice"]')).toContainText("尚未接通主进程剪贴板通道");
  await expect(page.locator('[data-testid="notice"]')).not.toContainText("已复制");
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("SENTINEL");
  await page.keyboard.press("Escape");
});

test("选择器修改只影响下次查询并有可见提示", async () => {
  await runWayback();
  await expect(page.locator('[data-testid="config-hint"]')).toHaveText(/冻结/);

  await page.selectOption('[data-testid="source-select"]', "commoncrawl");
  await expect(page.locator('[data-testid="config-hint"]')).toContainText("来源");
  await expect(page.locator('[data-testid="config-hint"]')).toContainText("下次查询");
  // 结果头仍显示本次任务冻结的来源
  await expect(page.locator('[data-testid="scope-label"]')).toContainText("来源 Wayback Machine");
  await expect(page.locator("#rows-body tr").first()).toBeVisible();

  await page.selectOption('[data-testid="source-select"]', "wayback");
  await expect(page.locator('[data-testid="config-hint"]')).toHaveText(/冻结/);

  await page.fill('[data-testid="target-input"]', "other.example.com");
  await expect(page.locator('[data-testid="config-hint"]')).toContainText("目标");
  await page.fill('[data-testid="target-input"]', "example.com");
  await expect(page.locator('[data-testid="config-hint"]')).toHaveText(/冻结/);
});

test("快速连续翻页以最后一次请求为准（旧响应不覆盖新视图）", async () => {
  await runWayback();
  await page.selectOption('[data-testid="page-size"]', "20");
  await expect(page.locator('[data-testid="page-label"]')).toHaveText("第 1 / 3 页");

  // 连续点击：多个 getView 可能在途，最终必须落在最后一次请求的页
  await page.click('[data-testid="next-page"]');
  await page.click('[data-testid="next-page"]');
  await expect(page.locator('[data-testid="page-label"]')).toHaveText("第 3 / 3 页", {
    timeout: 10_000,
  });
  await expect(page.locator("#rows-body tr").first().locator("td.rownum-col")).toHaveText("41");
  await page.selectOption('[data-testid="page-size"]', "50");
});

test("状态色块对比度不低于 4.5（CSS 渲染检查，非系统主题验收）", async () => {
  await runWayback();

  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(200);
  expect(await chipContrast()).toBeGreaterThanOrEqual(4.5);

  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(200);
  expect(await chipContrast()).toBeGreaterThanOrEqual(4.5);

  // 部分完成（暖色块）在深色下同样达标
  await page.selectOption('[data-testid="source-select"]', "commoncrawl");
  await page.selectOption('[data-testid="range-mode"]', "all");
  await page.fill('[data-testid="target-input"]', "example.com");
  await page.click('[data-testid="start-button"]');
  await expect(page.locator('[data-testid="status-chip"]')).toHaveText("部分完成", { timeout: 30_000 });
  await page.waitForTimeout(200);
  expect(await chipContrast()).toBeGreaterThanOrEqual(4.5);

  await page.emulateMedia({ colorScheme: "light" });
});
