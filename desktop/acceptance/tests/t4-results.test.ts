import test from "node:test";
import assert from "node:assert/strict";

import {
  ResultCollection, createIutUnderTest, applyFilter, sortRecords,
  type ArchiveRecord, type Transport, type TransportRequest,
} from "../harness/iut.ts";
import { createFixtureTransport } from "../harness/fixture-transport.ts";
import { readFixtureText, sha256 } from "../harness/fixtures.ts";
import {
  RecordingSink, baselineJsonRecords, fixedClock, makeRecord,
  sleep, waitForTerminal,
} from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");

test("T4: same-batch duplicates keep the first record", () => {
  const collection = new ResultCollection([
    makeRecord({ url: "https://example.com/a", statusCode: "200" }),
    makeRecord({ url: "https://example.com/a", statusCode: "301" }),
    makeRecord({ url: "https://example.com/b" }),
  ]);
  assert.deepEqual(collection.records.map((r) => r.url), ["https://example.com/a", "https://example.com/b"]);
  assert.equal(collection.records[0].statusCode, "200");
});

test("T4: cross-batch duplicates keep the first and report counts", () => {
  const collection = new ResultCollection([makeRecord({ url: "https://example.com/a", statusCode: "200" })]);
  const outcome = collection.append([
    makeRecord({ url: "https://example.com/a", statusCode: "301" }),
    makeRecord({ url: "https://example.com/b" }),
  ]);
  assert.equal(outcome.added, 1);
  assert.equal(outcome.duplicates, 1);
  assert.equal(outcome.knownDuplicates, 1);
  assert.equal(collection.records[0].statusCode, "200");
});

test("T4: URL identity is the full string; protocol/path/query differences stay distinct", () => {
  const collection = new ResultCollection([
    makeRecord({ url: "https://example.com/a" }),
    makeRecord({ url: "http://example.com/a" }),
    makeRecord({ url: "https://example.com/a?x=1" }),
    makeRecord({ url: "https://example.com/A" }),
  ]);
  assert.equal(collection.records.length, 4);
});

test("T4: filters match status/type/url/domain/interesting semantics", () => {
  const records = [
    makeRecord({ url: "https://www.example.com/admin", statusCode: "200", fileType: "text/html" }),
    makeRecord({ url: "https://cdn.example.com/app.js", statusCode: "301", fileType: "application/javascript" }),
    makeRecord({ url: "https://example.com/.env", statusCode: "403", fileType: "text/plain" }),
    makeRecord({ url: "https://other.com/a", statusCode: "404", fileType: "application/json" }),
  ];
  assert.equal(applyFilter(records, { status: "200,301" }).length, 2);
  assert.equal(applyFilter(records, { status: "!404" }).length, 3);
  assert.equal(applyFilter(records, { fileType: "application/" }).length, 2);
  assert.equal(applyFilter(records, { urlKeyword: "admin" }).length, 1);
  assert.equal(applyFilter(records, { domain: "example.com,!cdn.example.com" }).length, 2);
  assert.equal(applyFilter(records, { domain: "www.example.com (1)" }).length, 1);
  assert.deepEqual(applyFilter(records, { interestingOnly: true }).map((r) => r.url), [
    "https://www.example.com/admin",
    "https://example.com/.env",
  ]);
});

test("T4: append preserves the active filter and sort", () => {
  const collection = new ResultCollection([
    makeRecord({ url: "https://example.com/a", statusCode: "200", length: "10" }),
    makeRecord({ url: "https://example.com/b", statusCode: "301", length: "20" }),
  ]);
  collection.append([makeRecord({ url: "https://example.com/c", statusCode: "404", length: "30" })]);
  const view = collection.view({ status: "200" }, { column: "length", reverse: true });
  assert.deepEqual(view.map((r) => r.url), ["https://example.com/a"]);
});

test("T4: stable sort keeps receipt order for equal keys", () => {
  const collection = new ResultCollection([
    makeRecord({ url: "https://example.com/1", statusCode: "200" }),
    makeRecord({ url: "https://example.com/2", statusCode: "200" }),
    makeRecord({ url: "https://example.com/3", statusCode: "301" }),
  ]);
  const sorted = sortRecords(collection.records, { column: "status_code" });
  assert.deepEqual(sorted.map((r) => r.url), [
    "https://example.com/1",
    "https://example.com/2",
    "https://example.com/3",
  ]);
});

test("T4: paging is 0-based and empty collections report pageCount 0", () => {
  const records = Array.from({ length: 45 }, (_, i) => makeRecord({ url: `https://example.com/${i}` }));
  const collection = new ResultCollection(records);
  assert.equal(collection.pageCount(20), 3);
  assert.equal(collection.page(0, 20).length, 20);
  assert.equal(collection.page(2, 20).length, 5);
  assert.equal(collection.page(9, 20).length, 0);
  const empty = new ResultCollection([]);
  assert.equal(empty.pageCount(20), 0);
  assert.deepEqual(empty.page(0, 20), []);
});

test("T4: snapshot equals the current view and excludes internal fields", () => {
  const collection = new ResultCollection([
    makeRecord({ url: "https://example.com/a", statusCode: "200" }),
    makeRecord({ url: "https://example.com/b", statusCode: "404" }),
  ]);
  const snapshot = collection.snapshot({ status: "200" });
  assert.equal(snapshot.length, 1);
  assert.deepEqual(Object.keys(snapshot[0]), ["timestamp", "status_code", "length", "file_type", "url"]);
});

test("R1: clear/reset unconditionally invalidates view, page and snapshot", () => {
  const collection = new ResultCollection([makeRecord({ url: "https://example.com/a" })]);
  assert.equal(collection.view().length, 1);
  collection.clear();
  assert.equal(collection.view().length, 0);
  assert.equal(collection.page(0, 20).length, 0);
  assert.equal(collection.pageCount(20), 0);
  assert.deepEqual(collection.snapshot(), []);
  collection.reset([]);
  assert.equal(collection.view().length, 0);
  assert.deepEqual(collection.snapshot(), []);
});

class QuerySensitiveTransport implements Transport {
  calls: any[] = [];
  async fetchText(request: TransportRequest) {
    this.calls.push(request);
    if (request.jobId === 2) await sleep(40); // keep the new job empty while the view is read
    if (request.kind === "wayback-page") {
      const text = request.jobId === 1
        ? readFixtureText("sources/wayback_page_0.json")
        : readFixtureText("sources/wayback_empty.json");
      return { status: 200, text };
    }
    throw new Error(`unexpected kind ${request.kind}`);
  }
}

test("R1: a new query must not expose the previous query's rows/snapshot", async () => {
  const transport = new QuerySensitiveTransport();
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const first = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await waitForTerminal(iut, first.value.jobId);
  const firstView = iut.getView(first.value.jobId, "wayback");
  assert.equal(firstView.ok, true);
  if (firstView.ok) assert.equal(firstView.value.rows.length, 4);

  const second = iut.startQuery({ target: "other.example", source: "wayback", range: { kind: "all" } });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const secondView = iut.getView(second.value.jobId, "wayback");
  assert.equal(secondView.ok, true);
  if (!secondView.ok) return;
  assert.equal(secondView.value.rows.length, 0, "previous query rows leaked into the new view");
  assert.equal(secondView.value.pageCount, 0);
  assert.equal(secondView.value.unique, 0);

  const temp = `${process.env.TEMP ?? "."}/r1-export-${Date.now()}.csv`;
  const exported = iut.exportResults({
    jobId: second.value.jobId,
    source: "wayback",
    expectedRevision: secondView.value.revision,
    format: "csv",
    path: temp,
  });
  assert.equal(exported.ok, true);
  if (exported.ok) {
    assert.equal(exported.value.count, 0);
    const text = (await import("node:fs")).readFileSync(temp, "utf8");
    assert.equal(text.split("\r\n").filter(Boolean).length, 1, "stale rows leaked into export");
  }
  await waitForTerminal(iut, second.value.jobId);
});

test("T4: revision increments on reset, append and clear", () => {
  const collection = new ResultCollection();
  const r0 = collection.revision;
  collection.append([makeRecord({ url: "https://example.com/a" })]);
  assert.ok(collection.revision > r0);
  const r1 = collection.revision;
  collection.clear();
  assert.ok(collection.revision > r1);
  const r2 = collection.revision;
  collection.reset([]);
  assert.ok(collection.revision > r2);
});
