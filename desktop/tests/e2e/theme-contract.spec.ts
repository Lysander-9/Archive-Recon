import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";

const desktopRoot = path.resolve(__dirname, "..", "..");

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: [path.join(desktopRoot, "dist", "main", "main.js")] });
  page = await app.firstWindow();
  await page.waitForSelector('[data-testid="target-input"]');
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
});

test("theme contract returns the effective native theme and pushes updates", async () => {
  const initial = await page.evaluate(async () => {
    const bridge = (globalThis as unknown as { archiveRecon: any }).archiveRecon;
    return bridge.getTheme();
  });
  expect(initial.ok).toBe(true);
  expect(initial.value.schemaVersion).toBe(1);
  expect(typeof initial.value.shouldUseDarkColors).toBe("boolean");
  expect(["system", "light", "dark"]).toContain(initial.value.themeSource);

  const changePromise = page.evaluate(() => {
    const bridge = (globalThis as unknown as { archiveRecon: any }).archiveRecon;
    return new Promise<any>((resolve) => {
      const unsubscribe = bridge.onThemeChanged((state: any) => {
        unsubscribe();
        resolve(state);
      });
    });
  });

  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = "dark";
  });
  const changed = await changePromise;
  expect(changed.shouldUseDarkColors).toBe(true);
  expect(changed.themeSource).toBe("dark");

  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = "system";
  });
});

test("theme listener removal stops delivery and no raw ipc surface is exposed", async () => {
  const result = await page.evaluate(async () => {
    const bridge = (globalThis as unknown as { archiveRecon: any }).archiveRecon;
    let calls = 0;
    const unsubscribe = bridge.onThemeChanged(() => {
      calls += 1;
    });
    unsubscribe();
    return {
      calls,
      hasIpcRenderer: typeof (globalThis as any).ipcRenderer !== "undefined",
      keys: Object.keys(bridge).sort(),
    };
  });
  expect(result.calls).toBe(0);
  expect(result.hasIpcRenderer).toBe(false);
  expect(result.keys).toEqual(
    ["cancelQuery", "copyReasons", "copySelection", "exportResults", "getTheme", "getView", "onJobEvent", "onThemeChanged", "startQuery"],
  );
});
