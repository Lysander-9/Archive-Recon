import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CommonCrawlAdapter,
  parseCcIndex,
  resolveRange,
  selectIndexes,
  utcMonthWindow,
} from "../harness/generated/production.mjs";
import { createFixtureTransport, createManager } from "../harness/production-helpers.ts";
import { ACCEPTANCE_ROOT, readFixtureJson } from "../harness/fixtures.ts";
import { fixedClock } from "../harness/test-utils.ts";

const selectedRaw = readFixtureJson<any[]>("metadata/collinfo-selected.json");
const abnormalRaw = readFixtureJson<any[]>("metadata/collinfo-abnormal.json");
const selectedMetas = selectedRaw.map((item) => parseCcIndex(item)).filter(Boolean);
const abnormalMetas = abnormalRaw.map((item) => parseCcIndex(item)).filter(Boolean);

function ids(selection: any): string[] {
  return selection.indexes.map((item: any) => item.id);
}

test("T3: official from/to ranges select October 2024, not index IDs", () => {
  const clock = new Date(fixedClock("specific natural month"));
  const range = resolveRange({ kind: "month", year: 2024, month: 10 }, clock);
  const result = selectIndexes(selectedMetas, range);
  assert.deepEqual(ids(result), ["CC-MAIN-2024-42"]);
  assert.ok(!ids(result).includes("CC-MAIN-2024-38"));
  assert.ok(!ids(result).includes("CC-MAIN-2024-10"));
});

test("T3: cross-month indexes are selected in each intersecting natural month", () => {
  const clock = new Date("2025-05-15T00:00:00Z");
  const months: [number, number, string][] = [
    [2025, 4, "CC-MAIN-2025-18"],
    [2025, 5, "CC-MAIN-2025-18"],
    [2024, 2, "CC-MAIN-2024-10"],
    [2024, 3, "CC-MAIN-2024-10"],
  ];
  for (const [year, month, expected] of months) {
    const range = resolveRange({ kind: "month", year, month }, clock);
    assert.deepEqual(ids(selectIndexes(selectedMetas, range)), [expected], `${year}-${month}`);
  }
});

test("T3: recent N months are N natural months including the frozen month", () => {
  const clock = new Date(fixedClock("recent 3 natural months"));
  const range = resolveRange({ kind: "recent", months: 3 }, clock);
  assert.equal(range.window?.fromUtc, "2025-03-01T00:00:00.000Z");
  assert.equal(range.window?.toUtc, "2025-06-01T00:00:00.000Z");
  assert.deepEqual(ids(selectIndexes(selectedMetas, range)), ["CC-MAIN-2025-18"]);
});

test("T3: UTC month window is [month start, next month start)", () => {
  const window = utcMonthWindow(2024, 10);
  assert.equal(window.fromUtc, "2024-10-01T00:00:00.000Z");
  assert.equal(window.toUtc, "2024-11-01T00:00:00.000Z");
});

test("T3: missing/invalid/inverted metadata is unknown, not the week formula", () => {
  const clock = new Date(fixedClock("specific natural month"));
  const range = resolveRange({ kind: "month", year: 2024, month: 10 }, clock);
  const result = selectIndexes(abnormalMetas, range);
  assert.deepEqual(ids(result), ["CC-MAIN-2099-99"]);
  assert.equal(result.unknownExcluded, 4);
  const all = resolveRange({ kind: "all" }, clock);
  const allResult = selectIndexes(abnormalMetas, all);
  assert.equal(allResult.indexes.length, 5);
  assert.equal(allResult.unknownIncluded, true);
});

test("T3: official cdx-api and raw from/to are preserved", () => {
  const entry = selectedMetas.find((item: any) => item.id === "CC-MAIN-2024-42");
  assert.ok(entry);
  assert.equal(entry?.cdxApi, "https://index.commoncrawl.org/CC-MAIN-2024-42-index");
  assert.equal(entry?.fromRaw, "2024-10-03T09:40:20");
  assert.equal(entry?.toRaw, "2024-10-16T09:12:31");
});

test("T3: no-timezone official timestamps are treated as UTC (fixed TZ probe)", () => {
  const moduleUrl = pathToFileURL(path.join(ACCEPTANCE_ROOT, "harness", "generated", "production.mjs")).href;
  const script = [
    `import { parseOfficialTimestamp } from ${JSON.stringify(moduleUrl)};`,
    `const actual = parseOfficialTimestamp("2024-10-03T09:40:20");`,
    `const expected = Date.UTC(2024, 9, 3, 9, 40, 20);`,
    `console.log(JSON.stringify({ actual, expected }));`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, TZ: "Asia/Shanghai" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.actual, parsed.expected, "official timestamp was interpreted as local time");
});

test("T3: a UTC month boundary index is not included by a local-time shift", () => {
  const boundary = parseCcIndex({
    id: "CC-MAIN-BOUNDARY",
    "cdx-api": "https://index.commoncrawl.org/CC-MAIN-BOUNDARY-index",
    from: "2024-11-01T00:00:00",
    to: "2024-11-02T00:00:00",
  });
  assert.ok(boundary);
  const clock = new Date(fixedClock("specific natural month"));
  const range = resolveRange({ kind: "month", year: 2024, month: 10 }, clock);
  const result = selectIndexes([boundary], range);
  assert.deepEqual(ids(result), [], "November index must not intersect October");
});

test("T3: invalid calendar dates are unknown and never roll into the next month", () => {
  const invalidRanges = [
    ["2024-02-30T00:00:00", "2024-03-10T00:00:00"],
    ["20240230000000", "20240310000000"],
    ["2024-04-31T12:00:00", "2024-05-10T00:00:00"],
  ];
  for (const [from, to] of invalidRanges) {
    const meta = parseCcIndex({
      id: `CC-MAIN-INVALID-${from}`,
      "cdx-api": "https://index.commoncrawl.org/invalid-index",
      from,
      to,
    });
    assert.ok(meta);
    assert.equal(meta?.unknown, true, `invalid date rolled over: ${from}`);
    assert.equal(meta?.fromMs, null, `invalid date produced an epoch: ${from}`);
  }
});

test("T3: malformed Common Crawl lines are counted and surfaced as reasons", async () => {
  const transport = createFixtureTransport({ collinfo: "selected", pageCount: 1, wayback: "short" });
  const adapter = new CommonCrawlAdapter({ indexBaseUrl: "http://fixture.local/cc" });
  const index = selectedMetas.find((item: any) => item.id === "CC-MAIN-2024-42");
  assert.ok(index);
  const page = await adapter.queryPage(index, "example.com", 0, 5, {
    signal: new AbortController().signal,
    timeoutMs: 5000,
    transport,
  });
  assert.equal(page.records.length, 4);
  assert.equal(page.parseSkipped, 1);
  const reason = page.reasons.find((item: any) => item.code === "parse_line");
  assert.ok(reason);
  assert.equal(reason.count, 1);
  assert.equal(reason.source, "commoncrawl");
});

test("T3: job view exposes parse incompleteness and partial completion", async () => {
  const transport = createFixtureTransport({ collinfo: "selected", pageCount: 1 });
  const harness = createManager(transport, { clockUtc: fixedClock("specific natural month") });
  const started = await harness.start({
    target: "example.com",
    source: "commoncrawl",
    range: { kind: "month", year: 2024, month: 10 },
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "commoncrawl");
  assert.equal(view.status, "partial");
  assert.equal(view.completion, "partial");
  assert.ok(view.reasons.some((reason: any) => reason.code === "parse_line" && reason.count === 1));
});
