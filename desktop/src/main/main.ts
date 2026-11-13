/** Electron main process: window lifecycle, whitelisted IPC, export and clipboard. */

import { promises as fs } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, session as electronSession, type IpcMainInvokeEvent } from "electron";

import { JobManager } from "../application/job";
import { AppError } from "../application/errors";
import { CHANNELS } from "../contracts/channels";
import type { ExportOutcome, JobEventDto, Result, ThemeSource, ThemeState } from "../contracts/types";
import { SCHEMA_VERSION } from "../contracts/types";
import * as validate from "../contracts/validate";
import { CommonCrawlAdapter } from "./adapters/commoncrawl";
import { WaybackAdapter } from "./adapters/wayback";
import { exportFileName, writeExport } from "./export";
import { createElectronSessions } from "./sessions";

const TEST_MODE = process.env.ARCHRECON_TEST_MODE === "1";
const WAYBACK_URL = TEST_MODE ? process.env.ARCHRECON_WAYBACK_URL : undefined;
const CC_BASE_URL = TEST_MODE ? process.env.ARCHRECON_CC_INDEX_BASE : undefined;
const EXPORT_DIR = TEST_MODE ? process.env.ARCHRECON_EXPORT_DIR : undefined;

let mainWindow: BrowserWindow | null = null;
let manager: JobManager | null = null;

function toError(error: unknown): Result<never> {
  if (error instanceof AppError) return { ok: false, error: error.toDto() };
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: "INTERNAL", message } };
}

function guardSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  const expectedFrame = mainWindow?.webContents.mainFrame;
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    !frame ||
    !expectedFrame ||
    frame !== expectedFrame
  ) {
    throw new AppError("CLOSED", "拒绝非主窗口调用");
  }
}

function readTheme(): ThemeState {
  return {
    schemaVersion: SCHEMA_VERSION,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    themeSource: (nativeTheme.themeSource as ThemeSource) ?? "system",
  };
}

function sanitizeProxyEndpoint(value: string): string {
  return value.replace(/\/\/[^/@\s]+@/g, "//").replace(/\s+/g, " ").trim();
}

/**
 * Diagnostic-only hint: when a direct task fails but the OS/env exposes a proxy,
 * explain how to make the configuration effective. Never changes the task proxy
 * silently and never prints credentials or the full environment.
 */
async function proxyAdvice(mode: string): Promise<string | null> {
  const systemProxy = await (async (): Promise<string | null> => {
    try {
      const resolved = await electronSession.defaultSession.resolveProxy(
        "https://index.commoncrawl.org",
      );
      const match = /^PROXY\s+([^\s;]+)/i.exec(resolved);
      return match ? sanitizeProxyEndpoint(match[1]) : null;
    } catch {
      return null;
    }
  })();
  if (mode === "system" || mode === "fixed") {
    const label = mode === "system" ? "系统代理" : "固定代理";
    return systemProxy
      ? `本次任务使用${label}（${systemProxy}）；若该代理不可用，请在“网络设置”改为直连或填写可用的固定代理`
      : `本次任务使用${label}；若无法连通，请在“网络设置”改为直连或检查代理地址`;
  }
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;
  if (systemProxy) {
    return `系统代理可用（${systemProxy}），本次任务使用直连；可在“网络设置”选择系统代理或填写固定代理`;
  }
  if (envProxy) {
    return "检测到环境变量代理，但本次任务使用直连；请在“网络设置”填写该代理或选择系统代理";
  }
  return null;
}

async function handleExport(raw: unknown): Promise<Result<ExportOutcome>> {
  const parsed = validate.validateExport(raw);
  if (!parsed.ok) return parsed;
  if (!manager) return toError(new AppError("CLOSED", "应用尚未就绪"));
  const snapshot = manager.exportSnapshot(parsed.value);
  if (!snapshot.ok) return snapshot;

  const defaultName = exportFileName(parsed.value.source, parsed.value.format);
  let filePath: string | undefined;
  if (EXPORT_DIR) {
    await fs.mkdir(EXPORT_DIR, { recursive: true });
    filePath = path.join(EXPORT_DIR, `${Date.now()}-${defaultName}`);
  } else {
    const picked = await dialog.showSaveDialog(mainWindow as BrowserWindow, {
      defaultPath: defaultName,
      filters:
        parsed.value.format === "csv"
          ? [{ name: "CSV", extensions: ["csv"] }]
          : [{ name: "JSON", extensions: ["json"] }],
    });
    if (picked.canceled || !picked.filePath) {
      return { ok: true, value: { saved: false, count: 0 } };
    }
    filePath = picked.filePath;
  }

  const count = await writeExport(snapshot.value.rows, parsed.value.format, filePath);
  return { ok: true, value: { saved: true, count, filePath } };
}

function registerIpc(window: BrowserWindow): void {
  const sessions = createElectronSessions();
  manager = new JobManager({
    clock: () => new Date(),
    wayback: new WaybackAdapter({ baseUrl: WAYBACK_URL }),
    commoncrawl: new CommonCrawlAdapter({
      indexBaseUrl: CC_BASE_URL,
      allowInsecureCdxApi: TEST_MODE,
    }),
    sessions,
    proxyAdvice,
    emit: (event: JobEventDto) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return;
      window.webContents.send(CHANNELS.jobEvent, event);
    },
  });

  ipcMain.handle(CHANNELS.startQuery, async (event, raw) => {
    try {
      guardSender(event);
      const parsed = validate.validateStart(raw);
      if (!parsed.ok) return parsed;
      return await (manager as JobManager).start(parsed.value);
    } catch (error) {
      return toError(error);
    }
  });

  ipcMain.handle(CHANNELS.cancelQuery, (event, raw) => {
    try {
      guardSender(event);
      const parsed = validate.validateCancel(raw);
      if (!parsed.ok) return parsed;
      return (manager as JobManager).cancel(parsed.value);
    } catch (error) {
      return toError(error);
    }
  });

  ipcMain.handle(CHANNELS.getView, (event, raw) => {
    try {
      guardSender(event);
      const parsed = validate.validateGetView(raw);
      if (!parsed.ok) return parsed;
      return (manager as JobManager).getView(parsed.value);
    } catch (error) {
      return toError(error);
    }
  });

  ipcMain.handle(CHANNELS.exportResults, async (event, raw) => {
    try {
      guardSender(event);
      return await handleExport(raw);
    } catch (error) {
      return toError(error);
    }
  });

  ipcMain.handle(CHANNELS.copySelection, (event, raw) => {
    try {
      guardSender(event);
      const parsed = validate.validateCopy(raw);
      if (!parsed.ok) return parsed;
      const result = (manager as JobManager).copy(parsed.value);
      if (!result.ok) return result;
      clipboard.writeText(result.value.text);
      return { ok: true as const, value: { copiedCount: result.value.copiedCount } };
    } catch (error) {
      return toError(error);
    }
  });

  ipcMain.handle(CHANNELS.copyReasons, (event, raw) => {
    try {
      guardSender(event);
      const parsed = validate.validateCopyReasons(raw);
      if (!parsed.ok) return parsed;
      const result = (manager as JobManager).copyReasons(parsed.value);
      if (!result.ok) return result;
      if (result.value.outcome.copiedCount > 0) clipboard.writeText(result.value.text);
      return { ok: true as const, value: result.value.outcome };
    } catch (error) {
      return toError(error);
    }
  });

  ipcMain.handle(CHANNELS.themeGet, (event) => {
    try {
      guardSender(event);
      return { ok: true as const, value: readTheme() };
    } catch (error) {
      return toError(error);
    }
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    show: true,
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  // Restricted theme bridge: initial state via themeGet, changes via a single
  // fixed channel. The listener is removed when the window closes.
  const onThemeUpdated = (): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(CHANNELS.themeChanged, readTheme());
  };
  nativeTheme.on("updated", onThemeUpdated);

  window.on("closed", () => {
    nativeTheme.removeListener("updated", onThemeUpdated);
    manager?.closeAll();
    mainWindow = null;
  });

  registerIpc(window);
  void window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return window;
}

app.whenReady().then(() => {
  const defaultSession = electronSession.defaultSession;
  // Explicit denial: the app needs no camera, microphone, notifications, etc.
  defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  defaultSession.setPermissionCheckHandler(() => false);
  mainWindow = createWindow();
});

app.on("window-all-closed", () => {
  manager?.closeAll();
  app.quit();
});
