import test from "node:test";
import assert from "node:assert/strict";

import { proxySnapshot } from "../harness/generated/production.mjs";
import {
  createFixtureTransport,
  createManagerWithSessions,
} from "../harness/production-helpers.ts";
import { fixedClock, sleep } from "../harness/test-utils.ts";
import { waitFor } from "../harness/production-helpers.ts";

const CLOCK = fixedClock("specific natural month");

function request(target = "example.com") {
  return { target, source: "wayback", range: { kind: "all" }, proxy: { mode: "direct" } };
}

function delayedSessions(delayMs = 30) {
  const created: any[] = [];
  const closed: number[] = [];
  return {
    created,
    closed,
    async create(jobId: number, proxy: any) {
      created.push({ jobId, proxy });
      await sleep(delayMs);
      return { transport: null as any, proxy: proxySnapshot(proxy) };
    },
    async close(jobId: number) {
      closed.push(jobId);
    },
  };
}

test("R6: concurrent startQuery creates exactly one session and one request group", async () => {
  const transport = createFixtureTransport({ wayback: "short" });
  const sessions = delayedSessions();
  const harness = createManagerWithSessions(
    transport,
    {
      async create(jobId, proxy) {
        const session = await sessions.create(jobId, proxy);
        return { transport, proxy: session.proxy };
      },
      close: sessions.close,
    },
    { clockUtc: CLOCK },
  );

  const [first, second] = await Promise.all([
    harness.start(request("example.com")),
    harness.start(request("example.com")),
  ]);

  const okResults = [first, second].filter((result) => result.ok);
  const busyResults = [first, second].filter((result) => !result.ok);
  assert.equal(okResults.length, 1, `expected one accepted task, got ${okResults.length}`);
  assert.equal(busyResults.length, 1, "second concurrent start must be BUSY");
  if (busyResults.length === 1) {
    assert.equal(busyResults[0].error.code, "BUSY");
  }
  assert.equal(sessions.created.length, 1, "only one job session may be created");

  await waitFor(
    () => transport.callsOfKind("wayback-page").length === 1,
    2000,
    "one request group",
  );
  await sleep(50);
  assert.equal(transport.callsOfKind("wayback-page").length, 1);
});

test("R6: real double-click (two immediate starts) cannot create two jobs", async () => {
  const transport = createFixtureTransport({ wayback: "short" });
  const sessions = delayedSessions();
  const harness = createManagerWithSessions(
    transport,
    {
      async create(jobId, proxy) {
        const session = await sessions.create(jobId, proxy);
        return { transport, proxy: session.proxy };
      },
      close: sessions.close,
    },
    { clockUtc: CLOCK },
  );

  const firstPromise = harness.start(request("example.com"));
  const secondPromise = harness.start(request("example.com"));
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal([first, second].filter((result) => result.ok).length, 1);
  assert.equal([first, second].filter((result) => !result.ok && result.error.code === "BUSY").length, 1);
  assert.equal(sessions.created.length, 1);
  await sleep(60);
  assert.equal(transport.callsOfKind("wayback-page").length, 1);
});

test("R6: closeAll while sessions.create is pending must not start a request", async () => {
  const transport = createFixtureTransport({ wayback: "short" });
  const created: any[] = [];
  const closed: number[] = [];
  let resolveCreate: (() => void) | null = null;

  const harness = createManagerWithSessions(
    transport,
    {
      create(jobId, proxy) {
        created.push({ jobId, proxy });
        return new Promise((resolve) => {
          resolveCreate = () =>
            resolve({ transport, proxy: proxySnapshot(proxy) });
        });
      },
      async close(jobId) {
        closed.push(jobId);
      },
    },
    { clockUtc: CLOCK },
  );

  const startPromise = harness.start(request("example.com"));
  await waitFor(() => created.length === 1, 1000, "session creation started");
  harness.manager.closeAll();
  resolveCreate?.();
  const result = await startPromise;

  assert.equal(result.ok, false, "start resolved ok after the window was closed");
  assert.equal(transport.calls.length, 0, "request was issued after closeAll");
  await sleep(50);
  assert.ok(
    closed.includes(created[0].jobId),
    "session created after close must be closed",
  );
});

test("R6: closeAll calls session.close for the running job", async () => {
  const transport = createFixtureTransport({ wayback: "short", delay: { waybackPage: 0 } });
  const closed: number[] = [];
  const harness = createManagerWithSessions(
    transport,
    {
      async create(_jobId, proxy) {
        return { transport, proxy: proxySnapshot(proxy) };
      },
      async close(jobId) {
        closed.push(jobId);
      },
    },
    { clockUtc: CLOCK },
  );
  const started = await harness.start(request());
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await transport.waitForCall((call) => call.kind === "wayback-page");
  harness.manager.closeAll();
  await sleep(50);
  assert.ok(closed.includes(started.value.jobId), "closeAll did not close the job session");
});

test("R6: no new query may start after closeAll", async () => {
  const transport = createFixtureTransport({ wayback: "short" });
  const harness = createManagerWithSessions(
    transport,
    {
      async create(_jobId, proxy) {
        return { transport, proxy: proxySnapshot(proxy) };
      },
      async close() {},
    },
    { clockUtc: CLOCK },
  );
  harness.manager.closeAll();
  const result = await harness.start(request());
  assert.equal(result.ok, false, "startQuery was accepted after closeAll");
  if (!result.ok) {
    assert.ok(["CLOSED", "BUSY"].includes(result.error.code));
  }
  assert.equal(transport.calls.length, 0);
});
