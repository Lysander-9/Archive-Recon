import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { ResultCollection, EMPTY_FILTER, csvBuffer } from "../harness/generated/production.mjs";

function record(index: number) {
  return {
    url: `https://example.com/item/${index}?q=${index % 7}`,
    statusCode: index % 2 === 0 ? "200" : "404",
    length: String(10_000 - index),
    fileType: index % 5 === 0 ? "application/json" : "text/html",
    timestamp: `2024-${String((index % 12) + 1).padStart(2, "0")}-02`,
    rawTimestamp: "20240102030405",
    source: "wayback",
  };
}

test("T4/perf: 10k records filter + sort + page stays within the 2s target", (t) => {
  const records = Array.from({ length: 10_000 }, (_, index) => record(index));
  const collection = new ResultCollection(records);
  const filter = { ...EMPTY_FILTER, status: "200" };
  const sort = { key: "length", reverse: true };

  // Warm-up once, then measure three runs (cache invalidation behaves like a
  // filter/sort change between refreshes).
  collection.setFilter(filter);
  collection.setSort(sort);
  collection.page(0, 100);

  const timings: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    collection.setFilter(filter);
    collection.setSort(sort);
    const started = performance.now();
    const view = collection.view();
    const page = collection.page(0, 100);
    const snapshot = collection.snapshot();
    const elapsed = performance.now() - started;
    timings.push(elapsed);
    assert.equal(view.length, 5000);
    assert.equal(page.rows.length, 100);
    assert.equal(snapshot.length, 5000);
  }
  const worst = Math.max(...timings);
  t.diagnostic(`10k filter+sort+page+snapshot timings ms: ${timings.map((x) => x.toFixed(1)).join(", ")}; worst=${worst.toFixed(1)}`);
  assert.ok(worst < 2000, `10k filter/sort exceeded 2s target: ${worst.toFixed(1)}ms`);
});

test("T4/perf: 10k-row five-field CSV snapshot serializes within the 2s target", (t) => {
  const collection = new ResultCollection(Array.from({ length: 10_000 }, (_, index) => record(index)));
  collection.setFilter({ ...EMPTY_FILTER, status: "200" });
  collection.setSort({ key: "url", reverse: false });
  const started = performance.now();
  const bytes = csvBuffer(collection.snapshot() as any);
  const elapsed = performance.now() - started;
  t.diagnostic(`10k CSV snapshot bytes=${bytes.length} elapsed=${elapsed.toFixed(1)}ms`);
  assert.ok(bytes.length > 0);
  assert.ok(elapsed < 2000, `10k CSV snapshot exceeded 2s target: ${elapsed.toFixed(1)}ms`);
});
