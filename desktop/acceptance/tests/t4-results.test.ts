import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_FILTER,
  ResultCollection,
  applyFilter,
  sortRecords,
  matchDomainPattern,
} from "../harness/generated/production.mjs";
import { createFixtureTransport, createManager } from "../harness/production-helpers.ts";
import { fixedClock } from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");

function record(url: string, overrides: any = {}) {
  return {
    url,
    statusCode: "200",
    length: "100",
    fileType: "text/html",
    timestamp: "2024-01-02",
    rawTimestamp: "20240102030405",
    source: "wayback",
    ...overrides,
  };
}

function filter(partial: any = {}) {
  return { ...EMPTY_FILTER, ...partial };
}

test("T4: same-batch and cross-batch duplicate URLs keep the first record", () => {
  const collection = new ResultCollection([
    record("https://example.com/a", { statusCode: "200" }),
    record("https://example.com/a", { statusCode: "301" }),
    record("https://example.com/b"),
  ]);
  assert.deepEqual(collection.rawRecords().map((item: any) => item.url), [
    "https://example.com/a",
    "https://example.com/b",
  ]);
  assert.equal(collection.rawRecords()[0].statusCode, "200");

  const outcome = collection.append([
    record("https://example.com/a", { statusCode: "302" }),
    record("https://example.com/c"),
  ]);
  assert.equal(outcome.added, 1);
  assert.equal(outcome.knownDuplicates ?? outcome.duplicates, 1);
  assert.equal(collection.total, 3);
});

test("T4: full URL identity is preserved (protocol/path/query remain distinct)", () => {
  const collection = new ResultCollection([
    record("https://example.com/a"),
    record("http://example.com/a"),
    record("https://example.com/a?x=1"),
    record("https://example.com/A"),
  ]);
  assert.equal(collection.total, 4);
});

test("T4: filters match status/type/url/domain/interesting semantics", () => {
  const records = [
    record("https://www.example.com/admin", { statusCode: "200", fileType: "text/html" }),
    record("https://cdn.example.com/app.js", { statusCode: "301", fileType: "application/javascript" }),
    record("https://example.com/.env", { statusCode: "403", fileType: "text/plain" }),
    record("https://other.com/a", { statusCode: "404", fileType: "application/json" }),
  ];
  assert.equal(applyFilter(records, filter({ status: "200,301" })).length, 2);
  assert.equal(applyFilter(records, filter({ status: "!404" })).length, 3);
  assert.equal(applyFilter(records, filter({ fileType: "application/" })).length, 2);
  assert.equal(applyFilter(records, filter({ urlKeyword: "admin" })).length, 1);
  assert.equal(applyFilter(records, filter({ domain: "example.com,!cdn.example.com" })).length, 2);
  assert.deepEqual(
    applyFilter(records, filter({ interestingOnly: true })).map((item: any) => item.url),
    ["https://www.example.com/admin", "https://example.com/.env"],
  );
  assert.equal(matchDomainPattern("badexample.com", "example.com"), false);
});

test("T4: append preserves the active filter and sort", () => {
  const collection = new ResultCollection([
    record("https://example.com/a", { statusCode: "200", length: "10" }),
    record("https://example.com/b", { statusCode: "301", length: "20" }),
  ]);
  collection.setFilter(filter({ status: "200" }));
  collection.setSort({ key: "length", reverse: true });
  collection.append([
    record("https://example.com/c", { statusCode: "404", length: "30" }),
    record("https://example.com/d", { statusCode: "200", length: "5" }),
  ]);
  assert.deepEqual(collection.view().map((item: any) => item.url), [
    "https://example.com/a",
    "https://example.com/d",
  ]);
  assert.deepEqual(collection.view().map((item: any) => item.length), ["10", "5"]);
});

test("T4: stable sort keeps receipt order for equal keys", () => {
  const records = [
    record("https://example.com/1", { statusCode: "200" }),
    record("https://example.com/2", { statusCode: "200" }),
    record("https://example.com/3", { statusCode: "301" }),
  ];
  const sorted = sortRecords(records, { key: "status_code", reverse: false });
  assert.deepEqual(sorted.map((item: any) => item.url), [
    "https://example.com/1",
    "https://example.com/2",
    "https://example.com/3",
  ]);
});

test("T4: paging is 0-based and empty collections report pageCount 0", () => {
  const records = Array.from({ length: 45 }, (_, i) => record(`https://example.com/${i}`));
  const collection = new ResultCollection(records);
  assert.equal(collection.page(0, 20).pageCount, 3);
  assert.equal(collection.page(0, 20).rows.length, 20);
  assert.equal(collection.page(2, 20).rows.length, 5);
  const clamped = collection.page(9, 20);
  assert.equal(clamped.pageIndex, 2, "out-of-range page indexes are clamped");
  assert.equal(clamped.rows.length, 5);
  const empty = new ResultCollection([]);
  assert.equal(empty.page(0, 20).pageCount, 0);
  assert.deepEqual(empty.page(0, 20).rows, []);
});

test("T4: snapshot equals the current view and exposes only five fields", () => {
  const collection = new ResultCollection([
    record("https://example.com/a", { statusCode: "200" }),
    record("https://example.com/b", { statusCode: "404" }),
  ]);
  collection.setFilter(filter({ status: "200" }));
  const snapshot = collection.snapshot();
  assert.equal(snapshot.length, 1);
  assert.deepEqual(Object.keys(snapshot[0]), ["timestamp", "status_code", "length", "file_type", "url"]);
});

test("R1: reset/clear invalidates view, page and snapshot unconditionally", () => {
  const collection = new ResultCollection([record("https://example.com/a")]);
  assert.equal(collection.view().length, 1);
  collection.reset([]);
  assert.equal(collection.view().length, 0);
  assert.deepEqual(collection.page(0, 20), { rows: [], pageIndex: 0, pageCount: 0 });
  assert.deepEqual(collection.snapshot(), []);
});

test("R1: a new query never exposes the previous query rows/snapshot", async () => {
  const transport = createFixtureTransport({ wayback: "short" });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const first = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const firstView = await harness.waitTerminal(first.value.jobId, "wayback");
  assert.equal(firstView.unique, 4);

  const secondTransport = createFixtureTransport({ wayback: "empty", delay: { waybackPage: 0 } });
  const secondHarness = createManager(secondTransport, { clockUtc: CLOCK });
  const second = await secondHarness.start({ target: "other.example", source: "wayback", range: { kind: "all" } });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const view = secondHarness.view(second.value.jobId, "wayback");
  assert.equal(view.ok, true);
  if (!view.ok) return;
  assert.equal(view.value.rows.length, 0);
  assert.equal(view.value.pageCount, 0);
  assert.equal(view.value.unique, 0);
  await secondHarness.waitTerminal(second.value.jobId, "wayback");
});
