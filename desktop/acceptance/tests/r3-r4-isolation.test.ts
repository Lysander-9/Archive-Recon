import test from "node:test";
import assert from "node:assert/strict";

import { createFixtureTransport, createManager, waitFor } from "../harness/production-helpers.ts";
import { fixedClock } from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");

function hostParam(url: string): string {
  return new URL(url).searchParams.get("url") ?? "";
}

test("R3: each task freezes its own target across all requests", async () => {
  const transport = createFixtureTransport({ collinfo: "selected", pageCount: 1 });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const first = await harness.start({
    target: "alpha.example",
    source: "commoncrawl",
    range: { kind: "month", year: 2024, month: 10 },
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await harness.waitTerminal(first.value.jobId, "commoncrawl");
  const firstCalls = transport.callsOfKind("cc-page-count");
  assert.ok(firstCalls.length > 0);
  assert.ok(firstCalls.every((call) => hostParam(call.url) === "*.alpha.example"));

  const before = transport.calls.length;
  const second = await harness.start({
    target: "beta.example",
    source: "commoncrawl",
    range: { kind: "month", year: 2024, month: 10 },
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  await harness.waitTerminal(second.value.jobId, "commoncrawl");
  const secondCalls = transport.calls.slice(before).filter((call) => call.kind === "cc-page-count");
  assert.ok(secondCalls.length > 0);
  assert.ok(secondCalls.every((call) => hostParam(call.url) === "*.beta.example"));
  const firstView = harness.view(first.value.jobId, "commoncrawl");
  assert.equal(firstView.ok, true);
  if (firstView.ok) assert.equal(firstView.value.scope.host, "alpha.example");
});

test("R4: CC stop then Wayback start does not trigger CC work", async () => {
  const transport = createFixtureTransport({
    collinfo: "selected",
    pageCount: 7,
    repeatCcPage0: true,
    delay: { ccPage: 0 },
  });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const cc = await harness.start({ target: "example.com", source: "commoncrawl", range: { kind: "all" } });
  assert.equal(cc.ok, true);
  if (!cc.ok) return;
  await transport.waitForCall((call) => call.kind === "cc-page");
  harness.manager.cancel({ jobId: cc.value.jobId, source: "commoncrawl" });
  const ccView = await harness.waitTerminal(cc.value.jobId, "commoncrawl");
  assert.equal(ccView.status, "stopped");

  const before = transport.calls.filter((call) => call.kind.startsWith("cc-")).length;
  const wb = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(wb.ok, true);
  if (!wb.ok) return;
  await waitFor(
    () => transport.calls.filter((call) => call.kind.startsWith("cc-")).length === before,
    1000,
    "no CC calls during Wayback task",
  );
  await harness.waitTerminal(wb.value.jobId, "wayback");
  assert.equal(transport.calls.filter((call) => call.kind.startsWith("cc-")).length, before);
});

test("R4: wrong-source view/cancel/export are rejected", async () => {
  const transport = createFixtureTransport({ wayback: "short" });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "wayback");

  const wrongView = harness.view(started.value.jobId, "commoncrawl");
  const wrongCancel = harness.manager.cancel({ jobId: started.value.jobId, source: "commoncrawl" });
  const wrongExport = harness.manager.exportSnapshot({
    jobId: started.value.jobId,
    source: "commoncrawl",
    expectedRevision: view.revision,
    filter: { status: "", fileType: "", urlKeyword: "", domain: "", interestingOnly: false },
    sort: { key: null, reverse: false },
    format: "csv",
  });
  assert.equal(wrongView.ok, false);
  if (!wrongView.ok) assert.equal(wrongView.error.code, "STALE_VIEW");
  assert.equal(wrongCancel.ok, false);
  if (!wrongCancel.ok) assert.equal(wrongCancel.error.code, "STALE_VIEW");
  assert.equal(wrongExport.ok, false);
  if (!wrongExport.ok) assert.equal(wrongExport.error.code, "STALE_VIEW");
});

test("R4: all events for a job carry its source and jobId", async () => {
  const transport = createFixtureTransport({ wayback: "short" });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await harness.waitTerminal(started.value.jobId, "wayback");
  assert.ok(harness.events.length > 0);
  for (const event of harness.events) {
    assert.equal(event.jobId, started.value.jobId);
    assert.equal(event.source, "wayback");
  }
});
