import test from "node:test";
import assert from "node:assert/strict";

import {
  createIutUnderTest, type Transport, type TransportRequest,
} from "../harness/iut.ts";
import { createFixtureTransport } from "../harness/fixture-transport.ts";
import { readFixtureText } from "../harness/fixtures.ts";
import { fixedClock, waitFor, waitForTerminal } from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");

const TWO_INDEX_COLLINFO = JSON.stringify([
  {
    id: "CC-MAIN-TEST-A",
    name: "Synthetic A",
    "cdx-api": "https://index.commoncrawl.org/CC-MAIN-TEST-A-index",
    from: "2024-01-01T00:00:00",
    to: "2024-01-02T00:00:00",
  },
  {
    id: "CC-MAIN-TEST-B",
    name: "Synthetic B",
    "cdx-api": "https://index.commoncrawl.org/CC-MAIN-TEST-B-index",
    from: "2024-01-01T00:00:00",
    to: "2024-01-02T00:00:00",
  },
]);

class TwoIndexTransport implements Transport {
  calls: any[] = [];
  async fetchText(request: TransportRequest) {
    this.calls.push({ ...request });
    if (request.kind === "wayback-page") {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { status: 200, text: readFixtureText("sources/wayback_page_0.json") };
    }
    if (request.kind === "cc-collinfo") return { status: 200, text: TWO_INDEX_COLLINFO };
    if (request.kind === "cc-page-count") return { status: 200, text: '{"pages":1,"pageSize":5}' };
    if (request.kind === "cc-page") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        status: 200,
        text: JSON.stringify({
          url: `https://${new URL(request.url).searchParams.get("url")?.replace(/^\*\./, "") ?? "example.com"}/a`,
          status: "200",
          mime: "text/html",
          length: "1",
          timestamp: "20240102030405",
        }),
      };
    }
    throw new Error(`unexpected ${request.kind}`);
  }
}

function ccTarget(request: TransportRequest): string {
  return new URL(request.url).searchParams.get("url") ?? "";
}

test("R3: editing the input before the first index keeps the frozen target", async () => {
  const transport = createFixtureTransport({
    collinfo: "selected",
    pageCount: 1,
    delay: { ccCollinfo: 1 },
  });
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const started = iut.startQuery({
    target: "example.com",
    source: "commoncrawl",
    range: { kind: "month", year: 2024, month: 10 },
  });
  assert.equal(started.ok, true);
  iut.setTargetInput("other.example");
  await transport.waitForCall((call) => call.kind === "cc-page-count");
  await waitForTerminal(iut, (started as any).value.jobId);
  const calls = transport.callsOfKind("cc-page-count");
  assert.equal(calls.length, 1);
  assert.equal(ccTarget(calls[0]), "*.example.com", "first index used the edited input");
});

test("R3: editing the input between indexes keeps the frozen target", async () => {
  const transport = new TwoIndexTransport();
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const started = iut.startQuery({ target: "example.com", source: "commoncrawl", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await waitFor(() => transport.calls.some((call) => call.kind === "cc-page"), 2000, "first CC page");
  iut.setTargetInput("other.example");
  await waitForTerminal(iut, started.value.jobId);
  const counts = transport.calls.filter((call) => call.kind === "cc-page-count");
  assert.equal(counts.length, 2);
  for (const call of counts) {
    assert.equal(ccTarget(call), "*.example.com", "a later index used the edited input");
  }
});

test("R4: CC stop then Wayback running must not start CC work from scroll", async () => {
  const transport = createFixtureTransport({
    collinfo: "selected",
    pageCount: 7,
    ccRepeatPage0: true,
    delay: { ccPage: 0, waybackPage: 0 },
  });
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const cc = iut.startQuery({ target: "example.com", source: "commoncrawl", range: { kind: "all" } });
  assert.equal(cc.ok, true);
  if (!cc.ok) return;
  await transport.waitForCall((call) => call.kind === "cc-page");
  iut.cancelQuery(cc.value.jobId, "commoncrawl");
  assert.equal(await waitForTerminal(iut, cc.value.jobId), "stopped");

  const wb = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(wb.ok, true);
  if (!wb.ok) return;
  const before = transport.calls.filter((call) => call.source === "commoncrawl").length;
  const scroll = iut.scrollCc();
  assert.equal(scroll.ok, true);
  if (scroll.ok) assert.equal(scroll.value.accepted, false);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const after = transport.calls.filter((call) => call.source === "commoncrawl").length;
  assert.equal(after, before, "scroll triggered a Common Crawl request under a Wayback job");

  iut.cancelQuery(wb.value.jobId, "wayback");
  await waitForTerminal(iut, wb.value.jobId);
});

test("R4: wrong-source view/cancel are rejected", async () => {
  const transport = createFixtureTransport({ waybackFirstPage: "short" });
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const cc = iut.startQuery({ target: "example.com", source: "commoncrawl", range: { kind: "all" } });
  assert.equal(cc.ok, true);
  if (!cc.ok) return;
  iut.cancelQuery(cc.value.jobId, "commoncrawl");
  await waitForTerminal(iut, cc.value.jobId);

  const wrongView = iut.getView(cc.value.jobId, "wayback");
  const wrongCancel = iut.cancelQuery(cc.value.jobId, "wayback");
  assert.equal(wrongView.ok, false);
  if (!wrongView.ok) assert.equal(wrongView.error.code, "INVALID_INPUT");
  assert.equal(wrongCancel.ok, false);
  if (!wrongCancel.ok) assert.equal(wrongCancel.error.code, "INVALID_INPUT");
});

test("R4: events for the active job never carry the other source", async () => {
  const transport = createFixtureTransport({ delay: { waybackPage: 0 } });
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const events: any[] = [];
  iut.subscribe((event) => events.push(event));
  const wb = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(wb.ok, true);
  if (!wb.ok) return;
  await waitForTerminal(iut, wb.value.jobId);
  await iut.flushEvents();
  assert.ok(events.length > 0);
  for (const event of events.filter((item) => item.jobId === wb.value.jobId)) {
    assert.equal(event.source, "wayback");
  }
});
