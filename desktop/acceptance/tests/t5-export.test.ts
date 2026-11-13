import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";

import {
  EMPTY_FILTER,
  csvBuffer,
  jsonBuffer,
  writeExport,
} from "../harness/generated/production.mjs";
import { createFixtureTransport, createManager } from "../harness/production-helpers.ts";
import { fixturePath, readFixtureText } from "../harness/fixtures.ts";
import {
  TempDir,
  baselineCsvRecords,
  baselineJsonRecords,
  exportRows,
  fixedClock,
} from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");

test("T5: CSV bytes equal the original baseline five-field sample", () => {
  const bytes = csvBuffer(exportRows(baselineCsvRecords()) as any);
  const reference = readFileSync(fixturePath("export", "reference-baseline-sample.csv"));
  assert.equal(bytes.toString("hex"), reference.toString("hex"));
  assert.ok(bytes.toString("utf8").startsWith("﻿timestamp,status_code,length,file_type,url\r\n"));
});

test("T5: JSON structure matches the original baseline sample", () => {
  const bytes = jsonBuffer(exportRows(baselineJsonRecords()) as any);
  const referenceText = readFixtureText("export", "baseline-wayback.json");
  const expected = JSON.parse(referenceText);
  const actual = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(actual, expected);
  assert.deepEqual(Object.keys(actual[0]), ["timestamp", "status_code", "length", "file_type", "url"]);
  assert.ok(bytes.toString("utf8").includes("中文"));
  assert.ok(!bytes.toString("utf8").includes("\\u4e2d"));
});

test("T5: internal source/rawTimestamp/indexId/rowId are never exported", () => {
  const rows = exportRows(baselineCsvRecords()) as any[];
  const withInternal = rows.map((row, index) => ({
    ...row,
    source: "commoncrawl",
    rawTimestamp: "20240102030405",
    indexId: "CC-MAIN-2024-42",
    rowId: `r${index}`,
  }));
  const csv = csvBuffer(withInternal).toString("utf8");
  const json = JSON.parse(jsonBuffer(withInternal).toString("utf8"));
  assert.ok(!csv.includes("source"));
  assert.ok(!csv.includes("rawTimestamp"));
  assert.ok(!csv.includes("indexId"));
  assert.deepEqual(Object.keys(json[0]), ["timestamp", "status_code", "length", "file_type", "url"]);
});

class GeneratedWaybackTransport {
  calls: any[] = [];
  fetch = async (url: string) => {
    this.calls.push(url);
    const page = Number(new URL(url).searchParams.get("page") ?? "0");
    const sizes = [50, 50, 20];
    const count = sizes[page] ?? 0;
    const text = count
      ? JSON.stringify([
          ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
          ...Array.from({ length: count }, (_, i) => {
            const index = [0, 50, 100][page] + i;
            return [
              `com,example)/item/${index}`,
              "20240102030405",
              `https://example.com/item/${index}`,
              "text/html",
              index < 70 ? "200" : "404",
              `D${index}`,
              String(100 + index),
            ];
          }),
        ])
      : "[]";
    return { status: 200, text: async () => text, json: async () => JSON.parse(text) };
  }
}

test("T5: 120 records filtered to 70 export all 70 across pages", async () => {
  const transport = new GeneratedWaybackTransport();
  const harness = createManager(transport as any, { clockUtc: CLOCK });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "wayback");
  assert.equal(view.unique, 120);

  const filtered = { ...EMPTY_FILTER, status: "200" };
  const filteredView = harness.view(started.value.jobId, "wayback", filtered, { key: null, reverse: false }, 3, 20);
  assert.equal(filteredView.ok, true);
  if (!filteredView.ok) return;
  assert.equal(filteredView.value.matched, 70);
  assert.equal(filteredView.value.pageCount, 4);

  const snapshot = harness.manager.exportSnapshot({
    jobId: started.value.jobId,
    source: "wayback",
    expectedRevision: filteredView.value.revision,
    filter: filtered,
    sort: { key: null, reverse: false },
    format: "csv",
  });
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.equal(snapshot.value.rows.length, 70);

  const dir = new TempDir();
  try {
    const path = dir.file("120-70.csv");
    const count = await writeExport(snapshot.value.rows, "csv", path);
    assert.equal(count, 70);
    const lines = readFileSync(path, "utf8").replace(/^﻿/, "").trimEnd().split("\r\n");
    assert.equal(lines.length, 71);
  } finally {
    dir.dispose();
  }
});

test("T5: stale revision is rejected instead of exporting another range", async () => {
  const transport = createFixtureTransport({ wayback: "short" });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await harness.waitTerminal(started.value.jobId, "wayback");
  const snapshot = harness.manager.exportSnapshot({
    jobId: started.value.jobId,
    source: "wayback",
    expectedRevision: 0,
    filter: EMPTY_FILTER,
    sort: { key: null, reverse: false },
    format: "csv",
  });
  assert.equal(snapshot.ok, false);
  if (!snapshot.ok) assert.equal(snapshot.error.code, "STALE_VIEW");
});

test("T5: zero rows produce header-only CSV and an empty JSON array", () => {
  assert.equal(csvBuffer([]).toString("utf8"), "﻿timestamp,status_code,length,file_type,url\r\n");
  assert.equal(jsonBuffer([]).toString("utf8"), "[]");
});

test("T5: write failure reports EXPORT and leaves no temp residue", async () => {
  const dir = new TempDir();
  try {
    const target = dir.file("as-directory.csv");
    mkdirSync(target);
    await assert.rejects(() => writeExport([], "csv", target), (error: any) => error.code === "EXPORT");
    const leftovers = (await import("node:fs")).readdirSync(dir.path).filter((name: string) =>
      name.startsWith(".archrecon-")
    );
    assert.deepEqual(leftovers, []);
  } finally {
    dir.dispose();
  }
});

test("T5: copy selection uses the current revision and row ids", async () => {
  const transport = createFixtureTransport({ wayback: "short" });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "wayback");
  const rowIds = view.rows.slice(0, 2).map((row: any) => row.rowId);
  const copied = harness.manager.copy({
    jobId: started.value.jobId,
    source: "wayback",
    revision: view.revision,
    rowIds,
    mode: "url",
  });
  assert.equal(copied.ok, true);
  if (copied.ok) {
    assert.equal(copied.value.copiedCount, 2);
    assert.equal(copied.value.text.split("\r\n").length, 2);
  }
});
