import test from "node:test";
import assert from "node:assert/strict";

import {
  createIutUnderTest, selectIndexes, classifyMetadata,
  type CollInfoEntry,
} from "../harness/iut.ts";
import { createFixtureTransport } from "../harness/fixture-transport.ts";
import { recentMonthWindows, monthWindowUtc } from "../harness/clock.ts";
import { readFixtureJson } from "../harness/fixtures.ts";
import { fixedClock, waitForTerminal } from "../harness/test-utils.ts";

const selected = readFixtureJson<CollInfoEntry[]>("metadata/collinfo-selected.json");
const abnormal = readFixtureJson<CollInfoEntry[]>("metadata/collinfo-abnormal.json");

function ids(result: ReturnType<typeof selectIndexes>): string[] {
  return result.selected.map((item) => item.entry.id);
}

test("T3: specific natural month uses official ranges, not index IDs", () => {
  const result = selectIndexes(selected, { kind: "month", year: 2024, month: 10 }, fixedClock("specific natural month"));
  assert.deepEqual(ids(result), ["CC-MAIN-2024-42"]);
  // 2024-38 is a September index; the old week-number formula would have
  // mapped 38 -> October. Metadata must win.
  assert.ok(!ids(result).includes("CC-MAIN-2024-38"));
  assert.ok(!ids(result).includes("CC-MAIN-2024-10"));
});

test("T3: cross-month ranges select an index for each intersecting month", () => {
  const clock = "2025-05-15T00:00:00Z";
  assert.deepEqual(ids(selectIndexes(selected, { kind: "month", year: 2025, month: 4 }, clock)), ["CC-MAIN-2025-18"]);
  assert.deepEqual(ids(selectIndexes(selected, { kind: "month", year: 2025, month: 5 }, clock)), ["CC-MAIN-2025-18"]);
  assert.deepEqual(ids(selectIndexes(selected, { kind: "month", year: 2024, month: 2 }, clock)), ["CC-MAIN-2024-10"]);
  assert.deepEqual(ids(selectIndexes(selected, { kind: "month", year: 2024, month: 3 }, clock)), ["CC-MAIN-2024-10"]);
});

test("T3: recent N months is N natural months including the frozen month", () => {
  const clock = fixedClock("recent 3 natural months");
  const windows = recentMonthWindows(clock, 3);
  assert.deepEqual(windows.map((w) => `${w.year}-${String(w.month).padStart(2, "0")}`), ["2025-03", "2025-04", "2025-05"]);
  assert.equal(windows[0].start, "2025-03-01T00:00:00.000Z");
  assert.equal(windows[2].end, "2025-06-01T00:00:00.000Z");
  assert.deepEqual(ids(selectIndexes(selected, { kind: "months", months: 3 }, clock)), ["CC-MAIN-2025-18"]);
});

test("T3: month window is UTC [start, next start)", () => {
  const window = monthWindowUtc(2024, 10);
  assert.equal(window.start, "2024-10-01T00:00:00.000Z");
  assert.equal(window.end, "2024-11-01T00:00:00.000Z");
});

test("T3: missing/invalid/inverted metadata is 'range unknown', not the week formula", () => {
  const result = selectIndexes(abnormal, { kind: "month", year: 2024, month: 10 }, fixedClock("specific natural month"));
  assert.deepEqual(ids(result), ["CC-MAIN-2099-99"]);
  assert.equal(result.unknown.length, 4);
  for (const item of result.unknown) {
    assert.match(item.reason, /时间范围/);
  }
  assert.equal(classifyMetadata(abnormal[1]).kind, "unknown");
  assert.equal(classifyMetadata(abnormal[2]).kind, "unknown");
  assert.equal(classifyMetadata(abnormal[3]).kind, "unknown");
  assert.equal(classifyMetadata(abnormal[4]).kind, "unknown");
});

test("T3: all-time keeps unknown-range indexes and still reports them", () => {
  const result = selectIndexes(abnormal, { kind: "all" }, fixedClock("specific natural month"));
  assert.equal(result.selected.length, 5);
  assert.equal(result.unknown.length, 4);
  assert.deepEqual(ids(result), abnormal.map((entry) => entry.id));
});

test("T3: official cdx-api and raw from/to are preserved", () => {
  const entry = selected.find((item) => item.id === "CC-MAIN-2024-42") as Record<string, string> | undefined;
  assert.ok(entry);
  assert.equal(entry?.["cdx-api"], "https://index.commoncrawl.org/CC-MAIN-2024-42-index");
  assert.equal(entry?.from, "2024-10-03T09:40:20");
  assert.equal(entry?.to, "2024-10-16T09:12:31");
});

test("T3: task selects the metadata-derived index and keeps the frozen clock", async () => {
  const transport = createFixtureTransport({ collinfo: "selected", pageCount: 1 });
  const iut = createIutUnderTest({ transport, clockUtc: fixedClock("specific natural month") });
  const started = iut.startQuery({
    target: "example.com",
    source: "commoncrawl",
    range: { kind: "month", year: 2024, month: 10 },
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await waitForTerminal(iut, started.value.jobId);

  const pageCalls = transport.callsOfKind("cc-page-count");
  assert.equal(pageCalls.length, 1);
  assert.match(pageCalls[0].url, /CC-MAIN-2024-42-index/);
  assert.ok(!pageCalls.some((call) => call.url.includes("CC-MAIN-2024-38")));
  assert.equal(iut.getFrozenConfig(started.value.jobId)?.clockUtc, "2024-10-15T12:00:00.000Z");
});
