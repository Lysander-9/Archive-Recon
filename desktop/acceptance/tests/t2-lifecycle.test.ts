import test from "node:test";
import assert from "node:assert/strict";

import { createFixtureTransport, createManager } from "../harness/production-helpers.ts";
import { fixedClock, sleep } from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");

test("T2: successful Wayback query reaches completed with normalized rows", async () => {
  const transport = createFixtureTransport({ wayback: "short" });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "wayback");
  assert.equal(view.status, "completed");
  assert.equal(view.unique, 4); // fixture contains a duplicate URL
  assert.equal(view.rows[0].timestamp, "2024-01-02");
  assert.equal(view.rows[0].statusCode, "200");
});

test("T2: zero-result Wayback query completes with an empty view", async () => {
  const transport = createFixtureTransport({ wayback: "empty" });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "wayback");
  assert.equal(view.status, "completed");
  assert.equal(view.unique, 0);
  assert.equal(view.pageCount, 0);
  assert.deepEqual(view.rows, []);
});

test("T2: request failure without records ends failed; with records ends partial", async () => {
  const failing = createFixtureTransport({ fail: { waybackPage: 0 } });
  const first = createManager(failing, { clockUtc: CLOCK });
  const failed = await first.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(failed.ok, true);
  if (failed.ok) {
    const view = await first.waitTerminal(failed.value.jobId, "wayback");
    assert.equal(view.status, "failed");
    assert.equal(view.reasons.some((reason: any) => reason.code === "network"), true);
  }

  const partialTransport = createFixtureTransport({ wayback: "full", fail: { waybackPage: 1 } });
  const second = createManager(partialTransport, { clockUtc: CLOCK });
  const partial = await second.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(partial.ok, true);
  if (partial.ok) {
    const view = await second.waitTerminal(partial.value.jobId, "wayback");
    assert.equal(view.status, "partial");
    assert.equal(view.unique, 50);
  }
});

test("T2/R2: cancel during the final Wayback page lands stopped", async () => {
  const transport = createFixtureTransport({ wayback: "full", delay: { waybackPage: 1 } });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await transport.waitForCall((call) => call.kind === "wayback-page" && call.page === 1);
  harness.manager.cancel({ jobId: started.value.jobId, source: "wayback" });
  const view = await harness.waitTerminal(started.value.jobId, "wayback");
  assert.equal(view.status, "stopped");
  assert.equal(view.terminal, true);
  assert.equal(view.unique, 50, "records received before the stop must be retained");
});

test("T2/R2: cancel during an empty-page request lands stopped", async () => {
  const transport = createFixtureTransport({ wayback: "empty", delay: { waybackPage: 0 } });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await transport.waitForCall((call) => call.kind === "wayback-page");
  harness.manager.cancel({ jobId: started.value.jobId, source: "wayback" });
  const view = await harness.waitTerminal(started.value.jobId, "wayback");
  assert.equal(view.status, "stopped");
});

test("T2/R2: cancel during a Common Crawl final page lands stopped", async () => {
  const transport = createFixtureTransport({
    collinfo: "selected",
    pageCount: 1,
    delay: { ccPage: 0 },
  });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const started = await harness.start({
    target: "example.com",
    source: "commoncrawl",
    range: { kind: "month", year: 2024, month: 10 },
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await transport.waitForCall((call) => call.kind === "cc-page");
  harness.manager.cancel({ jobId: started.value.jobId, source: "commoncrawl" });
  const view = await harness.waitTerminal(started.value.jobId, "commoncrawl");
  assert.equal(view.status, "stopped");
  assert.equal(view.terminal, true);
});

test("T2: cancel is idempotent and terminal status is not overwritten", async () => {
  const transport = createFixtureTransport({ wayback: "short" });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "wayback");
  assert.equal(view.status, "completed");
  const first = harness.manager.cancel({ jobId: started.value.jobId, source: "wayback" });
  const second = harness.manager.cancel({ jobId: started.value.jobId, source: "wayback" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok) assert.equal(first.value.status, "completed");
  if (second.ok) assert.equal(second.value.status, "completed");
});

test("T2: a second task is rejected as BUSY while one is running", async () => {
  const transport = createFixtureTransport({ wayback: "short", delay: { waybackPage: 0 } });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const first = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(first.ok, true);
  const second = await harness.start({ target: "example.com", source: "commoncrawl", range: { kind: "all" } });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, "BUSY");
  if (first.ok) {
    harness.manager.cancel({ jobId: first.value.jobId, source: "wayback" });
    await harness.waitTerminal(first.value.jobId, "wayback");
  }
  await sleep(1);
});
