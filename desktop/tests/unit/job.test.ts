import { expect, test } from "@playwright/test";

import { JobManager } from "../../src/application/job";
import { AppError } from "../../src/application/errors";
import type { CommonCrawlPort, JobDeps, JobSession, WaybackPort } from "../../src/application/ports";
import { EMPTY_FILTER, type JobEventDto, type JobStatus } from "../../src/contracts/types";
import { parseCcIndex } from "../../src/domain/time";
import { proxySnapshot } from "../../src/main/adapters/proxy";
import { rawRecord } from "../support/builders";

const clock = new Date("2025-09-15T00:00:00Z");

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function deps(overrides: Partial<JobDeps> = {}): JobDeps & { events: JobEventDto[]; closed: number[] } {
  const events: JobEventDto[] = [];
  const closed: number[] = [];
  const session: JobSession = {
    transport: async () => ({ status: 200, text: async () => "[]", json: async () => [] }),
    proxy: proxySnapshot({ mode: "direct" }),
  };
  return {
    clock: () => clock,
    wayback: {
      queryPage: async () => ({ records: [], hasMore: false, parseSkipped: 0, reasons: [] }),
    } satisfies WaybackPort,
    commoncrawl: {
      fetchIndexes: async () => ({ metas: [], invalidCount: 0 }),
      pageCount: async () => 0,
      queryPage: async () => ({ records: [], hasMore: false, parseSkipped: 0, reasons: [] }),
    } satisfies CommonCrawlPort,
    sessions: {
      create: async () => session,
      close: async (jobId) => {
        closed.push(jobId);
      },
    },
    emit: (event) => events.push(event),
    events,
    closed,
    ...overrides,
  } as JobDeps & { events: JobEventDto[]; closed: number[] };
}

function viewOf(manager: JobManager, jobId: number, source: "wayback" | "commoncrawl" = "wayback") {
  const result = manager.getView({
    jobId,
    source,
    filter: { ...EMPTY_FILTER },
    sort: { key: null, reverse: false },
    pageIndex: 0,
    pageSize: 50,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function statusOf(manager: JobManager, jobId: number, source: "wayback" | "commoncrawl" = "wayback"): JobStatus {
  return viewOf(manager, jobId, source).status;
}

test.describe("job manager (T1/T2/T3)", () => {
  test("rejects invalid targets before creating a session", async () => {
    let created = 0;
    const manager = new JobManager(
      deps({
        sessions: {
          create: async () => {
            created += 1;
            throw new Error("should not run");
          },
          close: async () => undefined,
        },
      }),
    );

    const result = await manager.start({
      target: "user:pass@example.com",
      source: "wayback",
      range: { kind: "recent", months: 3 },
      proxy: { mode: "direct" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
    expect(created).toBe(0);
  });

  test("percent-encoded targets make zero session and transport calls", async () => {
    let created = 0;
    let queried = 0;
    const manager = new JobManager(
      deps({
        sessions: {
          create: async () => {
            created += 1;
            throw new Error("should not run");
          },
          close: async () => undefined,
        },
        wayback: {
          queryPage: async () => {
            queried += 1;
            return { records: [], hasMore: false, parseSkipped: 0, reasons: [] };
          },
        },
      }),
    );

    const result = await manager.start({
      target: "exa%6Dple.com",
      source: "wayback",
      range: { kind: "all" },
      proxy: { mode: "direct" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
    expect(created).toBe(0);
    expect(queried).toBe(0);
  });

  test("proxy setup failure fails the start and never queries", async () => {
    let queried = 0;
    const manager = new JobManager(
      deps({
        sessions: {
          create: async () => {
            throw new AppError("PROXY", "代理无效");
          },
          close: async () => undefined,
        },
        wayback: {
          queryPage: async () => {
            queried += 1;
            return { records: [], hasMore: false, parseSkipped: 0, reasons: [] };
          },
        },
      }),
    );

    const result = await manager.start({
      target: "example.com",
      source: "wayback",
      range: { kind: "recent", months: 3 },
      proxy: { mode: "fixed", server: "http://127.0.0.1:9" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PROXY");
    expect(queried).toBe(0);
  });

  test("second start is BUSY while the first is running", async () => {
    const manager = new JobManager(
      deps({
        wayback: {
          queryPage: (host, page, size, options) =>
            new Promise((_resolve, reject) => {
              options.signal.addEventListener(
                "abort",
                () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
                { once: true },
              );
            }),
        },
      }),
    );

    const first = await manager.start({
      target: "example.com",
      source: "wayback",
      range: { kind: "all" },
      proxy: { mode: "direct" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await manager.start({
      target: "example.com",
      source: "wayback",
      range: { kind: "all" },
      proxy: { mode: "direct" },
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("BUSY");

    manager.cancel({ jobId: first.value.jobId, source: "wayback" });
    await until(() => statusOf(manager, first.value.jobId) === "stopped");

    const third = await manager.start({
      target: "example.com",
      source: "wayback",
      range: { kind: "all" },
      proxy: { mode: "direct" },
    });
    expect(third.ok).toBe(true);
    if (third.ok) manager.closeAll();
  });

  test("cancel keeps received rows and lands exactly one terminal state", async () => {
    const environment = deps({
      wayback: {
        queryPage: async (_host, page, _size, options) => {
          if (page === 0) {
            return {
              records: [
                rawRecord("https://example.com/a"),
                rawRecord("https://example.com/b"),
              ],
              hasMore: true,
              parseSkipped: 0,
              reasons: [],
            };
          }
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true },
            );
          });
        },
      },
    });
    const manager = new JobManager(environment);

    const started = await manager.start({
      target: "example.com",
      source: "wayback",
      range: { kind: "all" },
      proxy: { mode: "direct" },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const jobId = started.value.jobId;

    await until(() => viewOf(manager, jobId).unique === 2);
    manager.cancel({ jobId, source: "wayback" });
    await until(() => viewOf(manager, jobId).terminal);

    const view = viewOf(manager, jobId);
    expect(view.status).toBe("stopped");
    expect(view.unique).toBe(2);
    expect(view.revision).toBeGreaterThan(0);

    const terminalEvents = environment.events.filter(
      (event) =>
        event.kind === "state" &&
        ["stopped", "completed", "partial", "failed"].includes(String(event.payload.status)),
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0].payload.status).toBe("stopped");

    manager.cancel({ jobId, source: "wayback" });
    expect(statusOf(manager, jobId)).toBe("stopped");
  });

  test("common crawl uses official intervals, page budget and unknown-range reasons", async () => {
    const overlapping = parseCcIndex({
      id: "CC-MAIN-2025-38",
      "cdx-api": "https://index.commoncrawl.org/CC-MAIN-2025-38-index",
      from: "20250801000000",
      to: "20250930235959",
    })!;
    const unknown = parseCcIndex({
      id: "CC-MAIN-2099-01",
      "cdx-api": "https://index.commoncrawl.org/CC-MAIN-2099-01-index",
    })!;
    const manager = new JobManager(
      deps({
        commoncrawl: {
          fetchIndexes: async () => ({ metas: [overlapping, unknown], invalidCount: 0 }),
          pageCount: async () => 6,
          queryPage: async (_index, _host, page) => ({
            records: page < 5 ? [rawRecord(`https://example.com/cc/${page}`, { source: "commoncrawl" })] : [],
            hasMore: true,
            parseSkipped: 0,
            reasons: [],
          }),
        },
      }),
    );

    const started = await manager.start({
      target: "example.com",
      source: "commoncrawl",
      range: { kind: "recent", months: 3 },
      proxy: { mode: "direct" },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const jobId = started.value.jobId;

    await until(() => viewOf(manager, jobId, "commoncrawl").terminal, 10_000);

    const view = viewOf(manager, jobId, "commoncrawl");
    expect(view.status).toBe("partial");
    expect(view.unique).toBe(5);
    expect(view.scope.rangeLabel).toContain("最近 3 个自然月");
    expect(view.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["range_unknown", "page_limit"]),
    );
  });

  test("export snapshot enforces revision and is immutable", async () => {
    const manager = new JobManager(
      deps({
        wayback: {
          queryPage: async (_host, page) => ({
            records:
              page === 0
                ? [
                    rawRecord("https://example.com/a", { statusCode: "200" }),
                    rawRecord("https://example.com/b", { statusCode: "404" }),
                  ]
                : [],
            hasMore: false,
            parseSkipped: 0,
            reasons: [],
          }),
        },
      }),
    );
    const started = await manager.start({
      target: "example.com",
      source: "wayback",
      range: { kind: "all" },
      proxy: { mode: "direct" },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const jobId = started.value.jobId;
    await until(() => viewOf(manager, jobId).terminal);

    const view = viewOf(manager, jobId);
    const stale = manager.exportSnapshot({
      jobId,
      source: "wayback",
      expectedRevision: view.revision - 1,
      filter: { ...EMPTY_FILTER },
      sort: { key: null, reverse: false },
      format: "csv",
    });
    expect(stale.ok).toBe(false);

    const fresh = manager.exportSnapshot({
      jobId,
      source: "wayback",
      expectedRevision: view.revision,
      filter: { ...EMPTY_FILTER, status: "200" },
      sort: { key: null, reverse: false },
      format: "csv",
    });
    expect(fresh.ok).toBe(true);
    if (fresh.ok) {
      expect(fresh.value.rows).toHaveLength(1);
      expect(Object.keys(fresh.value.rows[0])).toEqual([
        "timestamp",
        "status_code",
        "length",
        "file_type",
        "url",
      ]);
    }
  });

  test("terminal state is followed by a viewChanged with the final revision", async () => {
    const environment = deps({
      wayback: {
        queryPage: async () => ({
          records: [rawRecord("https://example.com/a"), rawRecord("https://example.com/b")],
          hasMore: false,
          parseSkipped: 0,
          reasons: [],
        }),
      },
    });
    const manager = new JobManager(environment);

    const started = await manager.start({
      target: "example.com",
      source: "wayback",
      range: { kind: "all" },
      proxy: { mode: "direct" },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const jobId = started.value.jobId;

    await until(() => viewOf(manager, jobId).terminal);
    const view = viewOf(manager, jobId);
    const jobEvents = environment.events.filter((event) => event.jobId === jobId);

    const terminalState = jobEvents
      .filter((event) => event.kind === "state")
      .filter((event) =>
        ["completed", "partial", "failed", "stopped"].includes(String(event.payload.status)),
      );
    expect(terminalState).toHaveLength(1);
    expect(terminalState[0].revision).toBe(view.revision);

    const last = jobEvents[jobEvents.length - 1];
    expect(last.kind).toBe("viewChanged");
    expect(last.revision).toBe(view.revision);
    expect(last.payload.terminal).toBe(true);

    // Immediately after the terminal event the view already carries the rows.
    expect(view.rows).toHaveLength(2);
  });

  test("concurrent starts reserve one slot: the second is BUSY with one session", async () => {
    let created = 0;
    const manager = new JobManager(
      deps({
        sessions: {
          create: async (jobId) => {
            created += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return {
              transport: async () => ({ status: 200, text: async () => "[]", json: async () => [] }),
              proxy: proxySnapshot({ mode: "direct" }),
            };
          },
          close: async () => undefined,
        },
        wayback: {
          queryPage: async () => ({
            records: [rawRecord("https://example.com/a")],
            hasMore: false,
            parseSkipped: 0,
            reasons: [],
          }),
        },
      }),
    );

    const [first, second] = await Promise.all([
      manager.start({ target: "example.com", source: "wayback", range: { kind: "all" }, proxy: { mode: "direct" } }),
      manager.start({ target: "example.com", source: "wayback", range: { kind: "all" }, proxy: { mode: "direct" } }),
    ]);

    expect(created).toBe(1);
    const outcomes = [first.ok, second.ok].sort();
    expect(outcomes).toEqual([false, true]);
    const rejected = first.ok ? second : first;
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("BUSY");
    manager.closeAll();
  });

  test("closing before session creation resolves rejects the task and closes it", async () => {
    let resolveSession!: (value: unknown) => void;
    const closedIds: number[] = [];
    const transportCalls: string[] = [];
    const manager = new JobManager(
      deps({
        sessions: {
          create: (jobId) =>
            new Promise((resolve) => {
              resolveSession = () =>
                resolve({
                  transport: async (url: string) => {
                    transportCalls.push(url);
                    return { status: 200, text: async () => "[]", json: async () => [] };
                  },
                  proxy: proxySnapshot({ mode: "direct" }),
                });
            }),
          close: async (jobId) => {
            closedIds.push(jobId);
          },
        },
      }),
    );

    const pending = manager.start({
      target: "example.com",
      source: "wayback",
      range: { kind: "all" },
      proxy: { mode: "direct" },
    });
    manager.closeAll();
    resolveSession(null);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CLOSED");
    expect(closedIds).toHaveLength(1);
    expect(transportCalls).toEqual([]);

    const afterClose = await manager.start({
      target: "example.com",
      source: "wayback",
      range: { kind: "all" },
      proxy: { mode: "direct" },
    });
    expect(afterClose.ok).toBe(false);
    if (!afterClose.ok) expect(afterClose.error.code).toBe("CLOSED");
  });

  test("closeAll closes every job session and is idempotent", async () => {
    const environment = deps({
      wayback: {
        queryPage: async (_host, _page, _size, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true },
            );
          }),
      },
    });
    const manager = new JobManager(environment);
    const started = await manager.start({
      target: "example.com",
      source: "wayback",
      range: { kind: "all" },
      proxy: { mode: "direct" },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    manager.closeAll();
    manager.closeAll();
    await until(() => viewOf(manager, started.value.jobId).terminal);

    expect(environment.closed.filter((id) => id === started.value.jobId).length).toBeGreaterThanOrEqual(2);
  });

  test("record budget truncates with a partial record_limit reason and stops pagination", async () => {
    let calls = 0;
    const manager = new JobManager(
      deps({
        budgets: { maxTaskRecords: 2 },
        wayback: {
          queryPage: async () => {
            calls += 1;
            return {
              records: [
                rawRecord("https://example.com/1"),
                rawRecord("https://example.com/2"),
                rawRecord("https://example.com/3"),
              ],
              hasMore: true,
              parseSkipped: 0,
              reasons: [],
            };
          },
        },
      }),
    );
    const started = await manager.start({
      target: "example.com",
      source: "wayback",
      range: { kind: "all" },
      proxy: { mode: "direct" },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await until(() => viewOf(manager, started.value.jobId).terminal);

    const view = viewOf(manager, started.value.jobId);
    expect(view.unique).toBe(2);
    expect(view.status).toBe("partial");
    expect(view.reasons.some((reason) => reason.code === "record_limit" && reason.count === 1)).toBe(true);
    expect(calls).toBe(1);
  });

  test("page_limit is only reported when the cap pages really had more data", async () => {
    const emptyFirstPage = new JobManager(
      deps({
        commoncrawl: {
          fetchIndexes: async () => ({ metas: [indexMeta()], invalidCount: 0 }),
          pageCount: async () => 6,
          queryPage: async () => ({ records: [], hasMore: false, parseSkipped: 0, reasons: [] }),
        },
      }),
    );
    const emptyStarted = await emptyFirstPage.start({
      target: "example.com",
      source: "commoncrawl",
      range: { kind: "all" },
      proxy: { mode: "direct" },
    });
    expect(emptyStarted.ok).toBe(true);
    if (!emptyStarted.ok) return;
    await until(() => viewOf(emptyFirstPage, emptyStarted.value.jobId, "commoncrawl").terminal);
    expect(
      viewOf(emptyFirstPage, emptyStarted.value.jobId, "commoncrawl").reasons.some(
        (reason) => reason.code === "page_limit",
      ),
    ).toBe(false);
  });

  test("invalid metadata entries are counted as unknown-range reasons", async () => {
    const manager = new JobManager(
      deps({
        commoncrawl: {
          fetchIndexes: async () => ({ metas: [], invalidCount: 2 }),
          pageCount: async () => 0,
          queryPage: async () => ({ records: [], hasMore: false, parseSkipped: 0, reasons: [] }),
        },
      }),
    );
    const started = await manager.start({
      target: "example.com",
      source: "commoncrawl",
      range: { kind: "recent", months: 3 },
      proxy: { mode: "direct" },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await until(() => viewOf(manager, started.value.jobId, "commoncrawl").terminal);
    const view = viewOf(manager, started.value.jobId, "commoncrawl");
    const reason = view.reasons.find((item) => item.code === "range_unknown");
    expect(reason?.count).toBe(2);
    expect(view.status).toBe("partial");
  });

  test("terminal transition advances the revision", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new JobManager(
      deps({
        wayback: {
          queryPage: async () => {
            await gate;
            return {
              records: [rawRecord("https://example.com/a")],
              hasMore: false,
              parseSkipped: 0,
              reasons: [],
            };
          },
        },
      }),
    );
    const started = await manager.start({
      target: "example.com",
      source: "wayback",
      range: { kind: "all" },
      proxy: { mode: "direct" },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const runningRevision = viewOf(manager, started.value.jobId).revision;
    release();
    await until(() => viewOf(manager, started.value.jobId).terminal);
    expect(viewOf(manager, started.value.jobId).revision).toBeGreaterThan(runningRevision);
  });

  test("metadata overrun surfaces a visible reason instead of failing silently", async () => {
    const manager = new JobManager(
      deps({
        commoncrawl: {
          fetchIndexes: async () => {
            throw new AppError("PARSE", "响应体超过 8388608 字节上限，已中止读取");
          },
          pageCount: async () => 0,
          queryPage: async () => ({ records: [], hasMore: false, parseSkipped: 0, reasons: [] }),
        },
      }),
    );
    const started = await manager.start({
      target: "example.com",
      source: "commoncrawl",
      range: { kind: "recent", months: 3 },
      proxy: { mode: "direct" },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await until(() => viewOf(manager, started.value.jobId, "commoncrawl").terminal);

    const view = viewOf(manager, started.value.jobId, "commoncrawl");
    expect(view.status).toBe("partial");
    const reason = view.reasons.find((item) => item.code === "range_unknown");
    expect(reason?.message).toContain("读取预算");
  });

  test("reason summary copy is revision-checked and restricted to the job", () => {
    const environment = deps();
    const manager = new JobManager(environment);
    const job = manager as unknown as { jobs: Map<number, any> };
    job.jobs.set(1, {
      id: 1,
      source: "wayback",
      collection: { revision: 3 },
      reasons: [
        { code: "parse_line", message: "1 行被跳过", source: "wayback", count: 1, page: 0 },
      ],
      terminal: true,
    });

    const stale = manager.copyReasons({ jobId: 1, source: "wayback", revision: 2 });
    expect(stale.ok).toBe(false);

    const copied = manager.copyReasons({ jobId: 1, source: "wayback", revision: 3 });
    expect(copied.ok).toBe(true);
    if (copied.ok) {
      expect(copied.value.outcome.reasonCount).toBe(1);
      expect(copied.value.text).toContain("parse_line");
    }

    const wrongSource = manager.copyReasons({ jobId: 1, source: "commoncrawl", revision: 3 });
    expect(wrongSource.ok).toBe(false);
  });
});

function indexMeta(): any {
  return {
    id: "CC-MAIN-TEST",
    cdxApi: "https://index.commoncrawl.org/CC-MAIN-TEST-index",
    fromMs: Date.UTC(2025, 7, 1),
    toMs: Date.UTC(2025, 9, 1),
    unknown: false,
    fromRaw: "20250801000000",
    toRaw: "20251001000000",
  };
}
