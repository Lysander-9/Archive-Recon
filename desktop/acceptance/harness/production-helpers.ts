/**
 * Fixture transport and JobManager harness over the REAL production modules.
 * No reference implementation is imported here.
 */

import { readFixtureText } from "./fixtures.ts";
import {
  JobManager,
  WaybackAdapter,
  CommonCrawlAdapter,
  EMPTY_FILTER,
  buildProxyConfig,
  proxySnapshot,
} from "./generated/production.mjs";

export type WaybackVariant = "short" | "full" | "empty";
export type CollInfoVariant = "selected" | "full" | "abnormal";

export interface TransportOptions {
  wayback?: WaybackVariant;
  collinfo?: CollInfoVariant;
  pageCount?: 1 | 2 | 3 | 7;
  delay?: {
    waybackPage?: number;
    ccPage?: number;
    ccCollinfo?: number;
    ccPageCount?: number;
  };
  fail?: {
    waybackPage?: number;
    ccPage?: number;
    ccPageCount?: number;
    ccCollinfo?: boolean;
  };
  repeatCcPage0?: boolean;
}

export interface RecordedCall {
  url: string;
  page: number | null;
  kind: string;
  at: number;
}

export interface FixtureTransport {
  (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<{
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }>;
  calls: RecordedCall[];
  urls: string[];
  waitForCall(predicate: (call: RecordedCall) => boolean, timeoutMs?: number): Promise<RecordedCall>;
  callsOfKind(kind: string): RecordedCall[];
}

const WAYBACK_FILES: Record<WaybackVariant, string> = {
  short: "sources/wayback_page_0.json",
  full: "sources/wayback_full_page.json",
  empty: "sources/wayback_empty.json",
};

const COLLINFO_FILES: Record<CollInfoVariant, string> = {
  selected: "metadata/collinfo-selected.json",
  full: "metadata/collinfo-2026-11-13.json",
  abnormal: "metadata/collinfo-abnormal.json",
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function response(text: string, status = 200) {
  return {
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function classify(url: string): { kind: string; page: number | null; pathname: string } {
  const parsed = new URL(url);
  const hasPage = parsed.searchParams.has("page");
  const pageValue = hasPage ? Number(parsed.searchParams.get("page")) : null;
  if (parsed.pathname.endsWith("/collinfo.json")) return { kind: "cc-collinfo", page: pageValue, pathname: parsed.pathname };
  if (parsed.pathname.includes("cdx/search/cdx") || parsed.pathname.endsWith("/wayback")) {
    return { kind: "wayback-page", page: hasPage ? pageValue : 0, pathname: parsed.pathname };
  }
  if (parsed.searchParams.get("showNumPages") === "true") {
    return { kind: "cc-page-count", page: pageValue, pathname: parsed.pathname };
  }
  if (parsed.pathname.includes("-index")) {
    return { kind: "cc-page", page: hasPage ? pageValue : 0, pathname: parsed.pathname };
  }
  return { kind: "unknown", page: pageValue, pathname: parsed.pathname };
}

export function createFixtureTransport(options: TransportOptions = {}): FixtureTransport {
  const calls: RecordedCall[] = [];
  const waybackVariant = options.wayback ?? "short";

  const transport = (async (url, init) => {
    const { kind, page } = classify(url);
    calls.push({ url, page, kind, at: Date.now() });

    if (kind === "cc-collinfo" && options.delay?.ccCollinfo !== undefined) {
      await sleep(30, init?.signal);
    }
    if (kind === "wayback-page" && options.delay?.waybackPage !== undefined && page === options.delay.waybackPage) {
      await sleep(30, init?.signal);
    }
    if (kind === "cc-page" && options.delay?.ccPage !== undefined && page === options.delay.ccPage) {
      await sleep(30, init?.signal);
    }
    if (kind === "cc-page-count" && options.delay?.ccPageCount !== undefined) {
      await sleep(30, init?.signal);
    }

    if (
      (kind === "cc-collinfo" && options.fail?.ccCollinfo) ||
      (kind === "wayback-page" && options.fail?.waybackPage === page) ||
      (kind === "cc-page" && options.fail?.ccPage === page) ||
      (kind === "cc-page-count" && options.fail?.ccPageCount === page)
    ) {
      throw new Error("synthetic fixture failure");
    }

    if (kind === "wayback-page") {
      if (page === null || page === 0) return response(readFixtureText(WAYBACK_FILES[waybackVariant]));
      if (page === 1) return response(readFixtureText("sources/wayback_page_1.json"));
      return response(readFixtureText("sources/wayback_empty.json"));
    }
    if (kind === "cc-collinfo") {
      return response(readFixtureText(COLLINFO_FILES[options.collinfo ?? "selected"]));
    }
    if (kind === "cc-page-count") {
      const pageCount = options.pageCount ?? 1;
      const file = pageCount === 1
        ? "cc_page_count_one.json"
        : pageCount === 2
          ? "cc_page_count_two.json"
          : "cc_page_count.json";
      return response(readFixtureText("sources", file));
    }
    if (kind === "cc-page") {
      if (page === null || page === 0) return response(readFixtureText("sources/cc_page_0.ndjson"));
      if (page === 1) return response(readFixtureText("sources/cc_page_1.ndjson"));
      if (options.repeatCcPage0) return response(readFixtureText("sources/cc_page_0.ndjson"));
      return response("");
    }
    throw new Error(`unexpected fixture URL: ${url}`);
  }) as FixtureTransport;

  transport.calls = calls;
  transport.urls = [];
  transport.waitForCall = async (predicate, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = calls.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("timed out waiting for transport call");
  };
  transport.callsOfKind = (kind) => calls.filter((call) => call.kind === kind);
  return transport;
}

export interface ManagerOptions {
  clockUtc?: string;
  proxy?: { mode: "direct" | "system" | "fixed"; server?: string };
}

export interface ManagerHarness {
  manager: any;
  events: any[];
  sessions: { created: any[]; closed: number[] };
  transport: FixtureTransport;
  start(request: {
    target: string;
    source: "wayback" | "commoncrawl";
    range: any;
    proxy?: any;
  }): Promise<any>;
  view(jobId: number, source: "wayback" | "commoncrawl", filter?: any, sort?: any, pageIndex?: number, pageSize?: number): any;
  waitTerminal(jobId: number, source: "wayback" | "commoncrawl", timeoutMs?: number): Promise<any>;
}

export function createManager(transport: FixtureTransport | { fetch: Function }, options: ManagerOptions = {}): ManagerHarness {
  const transportFn = (typeof transport === "function"
    ? transport
    : (url: string, init?: any) => transport.fetch(url, init)) as FixtureTransport;
  const events: any[] = [];
  const sessions = { created: [] as any[], closed: [] as number[] };
  const clockUtc = options.clockUtc ?? "2024-10-15T12:00:00Z";
  const manager = new JobManager({
    clock: () => new Date(clockUtc),
    wayback: new WaybackAdapter({ baseUrl: "http://fixture.local/wayback" }),
    commoncrawl: new CommonCrawlAdapter({ indexBaseUrl: "http://fixture.local/cc" }),
    sessions: {
      async create(jobId: number, proxy: any) {
        buildProxyConfig(proxy); // production validation, including no direct fallback
        sessions.created.push({ jobId, proxy });
        return { transport: transportFn, proxy: proxySnapshot(proxy) };
      },
      async close(jobId: number) {
        sessions.closed.push(jobId);
      },
    },
    emit: (event: any) => events.push(event),
  });

  const harness: ManagerHarness = {
    manager,
    events,
    sessions,
    transport: transportFn,
    async start(request) {
      const result = await manager.start({
        target: request.target,
        source: request.source,
        range: request.range,
        proxy: request.proxy ?? options.proxy ?? { mode: "direct" },
      });
      return result;
    },
    view(jobId, source, filter = { ...EMPTY_FILTER }, sort = { key: null, reverse: false }, pageIndex = 0, pageSize = 50) {
      return manager.getView({ jobId, source, filter, sort, pageIndex, pageSize });
    },
    async waitTerminal(jobId, source, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const view = harness.view(jobId, source);
        if (view.ok && view.value.terminal) return view.value;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const view = harness.view(jobId, source);
      throw new Error(`job ${jobId} not terminal: ${JSON.stringify(view)}`);
    },
  };
  return harness;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export { EMPTY_FILTER };
