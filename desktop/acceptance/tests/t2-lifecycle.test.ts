import test from "node:test";
import assert from "node:assert/strict";

import {
  createIutUnderTest, type Transport, type TransportRequest,
} from "../harness/iut.ts";
import { createFixtureTransport } from "../harness/fixture-transport.ts";
import { readFixtureText } from "../harness/fixtures.ts";
import { fixedClock, sleep, waitFor, waitForTerminal } from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");

test("T2: successful Wayback query reaches completed with normalized rows", async () => {
  const transport = createFixtureTransport();
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const started = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(iut.getStatus(started.value.jobId), "running");
  assert.equal(await waitForTerminal(iut, started.value.jobId), "completed");
  const view = iut.getView(started.value.jobId, "wayback");
  assert.equal(view.ok, true);
  if (!view.ok) return;
  assert.equal(view.value.unique, 4);
  assert.equal(view.value.rows[0].timestamp, "2024-01-02");
  assert.equal(view.value.rows[0].statusCode, "200");
});

test("T2: zero-result Wayback query completes with an empty view", async () => {
  const transport = createFixtureTransport({ waybackFirstPage: "empty" });
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const started = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(await waitForTerminal(iut, started.value.jobId), "completed");
  const view = iut.getView(started.value.jobId, "wayback");
  assert.equal(view.ok, true);
  if (!view.ok) return;
  assert.equal(view.value.unique, 0);
  assert.equal(view.value.pageCount, 0);
  assert.deepEqual(view.value.rows, []);
});

test("T2: a request error without records ends failed; with records ends partial", async () => {
  class FirstPageThenError implements Transport {
    calls: any[] = [];
    async fetchText(request: TransportRequest) {
      this.calls.push(request);
      if ((request.page ?? 0) === 0) {
        return { status: 200, text: readFixtureText("sources/wayback_full_page.json") };
      }
      throw new Error("synthetic network failure");
    }
  }
  const transport = new FirstPageThenError();
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const started = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(await waitForTerminal(iut, started.value.jobId), "partial");
  const view = iut.getView(started.value.jobId, "wayback");
  assert.equal(view.ok, true);
  if (view.ok) assert.equal(view.value.unique, 50);

  const failing = createIutUnderTest({
    transport: { calls: [], async fetchText() { throw new Error("synthetic network failure"); } },
    clockUtc: CLOCK,
  });
  const failed = failing.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(failed.ok, true);
  if (!failed.ok) return;
  assert.equal(await waitForTerminal(failing, failed.value.jobId), "failed");
});

test("T2/R2: cancel during the final Wayback page lands stopped", async () => {
  const transport = createFixtureTransport({
    waybackFirstPage: "full",
    delay: { waybackPage: 1 },
  });
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const started = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await transport.waitForCall((call) => call.kind === "wayback-page" && call.url.includes("page=1"));
  const cancel = iut.cancelQuery(started.value.jobId, "wayback");
  assert.equal(cancel.ok, true);
  assert.equal(await waitForTerminal(iut, started.value.jobId), "stopped");
  const view = iut.getView(started.value.jobId, "wayback");
  assert.equal(view.ok, true);
  if (view.ok) assert.equal(view.value.unique, 50, "records received before the stop must be retained");
});

test("T2/R2: cancel during an empty-page request lands stopped", async () => {
  const transport = createFixtureTransport({
    waybackFirstPage: "empty",
    delay: { waybackPage: 0 },
  });
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const started = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await transport.waitForCall((call) => call.kind === "wayback-page");
  iut.cancelQuery(started.value.jobId, "wayback");
  assert.equal(await waitForTerminal(iut, started.value.jobId), "stopped");
});

test("T2: cancel is idempotent and terminal state cannot be overwritten", async () => {
  const transport = createFixtureTransport();
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const started = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(await waitForTerminal(iut, started.value.jobId), "completed");
  const first = iut.cancelQuery(started.value.jobId, "wayback");
  const second = iut.cancelQuery(started.value.jobId, "wayback");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok) assert.equal(first.value.status, "completed");
  if (second.ok) assert.equal(second.value.status, "completed");
});

test("T2/R2: cancel during a Common Crawl final page lands stopped", async () => {
  const transport = createFixtureTransport({
    collinfo: "selected",
    pageCount: 1,
    delay: { ccPage: 0 },
  });
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const started = iut.startQuery({
    target: "example.com",
    source: "commoncrawl",
    range: { kind: "month", year: 2024, month: 10 },
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await transport.waitForCall((call) => call.kind === "cc-page");
  iut.cancelQuery(started.value.jobId, "commoncrawl");
  assert.equal(await waitForTerminal(iut, started.value.jobId), "stopped");
  const view = iut.getView(started.value.jobId, "commoncrawl");
  assert.equal(view.ok, true);
});

test("T2: a second task is rejected as BUSY while one is running", async () => {
  const transport = createFixtureTransport({ delay: { waybackPage: 0 } });
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const first = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(first.ok, true);
  const second = iut.startQuery({ target: "example.com", source: "commoncrawl", range: { kind: "all" } });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, "BUSY");
  if (first.ok) {
    iut.cancelQuery(first.value.jobId, "wayback");
  }
});
