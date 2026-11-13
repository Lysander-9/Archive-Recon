import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";

import {
  createIutUnderTest, serializeCsv, serializeJson, writeExportAtomically,
  ResultCollection, type Transport, type TransportRequest,
} from "../harness/iut.ts";
import { createFixtureTransport } from "../harness/fixture-transport.ts";
import { fixturePath, readFixtureText } from "../harness/fixtures.ts";
import {
  TempDir, baselineCsvRecords, baselineJsonRecords, fixedClock,
  makeRecord, waitForTerminal,
} from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");
const FIELDS = ["timestamp", "status_code", "length", "file_type", "url"];

test("T5: CSV bytes equal the original baseline five-field sample", () => {
  const bytes = serializeCsv(baselineCsvRecords());
  const reference = readFileSync(fixturePath("export", "reference-baseline-sample.csv"));
  assert.equal(bytes.toString("hex"), reference.toString("hex"));
  assert.equal(bytes[0], 0xef);
  assert.equal(bytes[1], 0xbb);
  assert.equal(bytes[2], 0xbf);
  assert.ok(bytes.toString("utf8").startsWith("﻿timestamp,status_code,length,file_type,url\r\n"));
});

test("T5: JSON structure matches the original baseline sample", () => {
  const bytes = serializeJson(baselineJsonRecords());
  const referenceText = readFixtureText("export", "baseline-wayback.json");
  const expected = JSON.parse(referenceText);
  const actual = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(actual, expected);
  assert.deepEqual(Object.keys(actual[0]), FIELDS);
  assert.equal(actual[0]["url"], "https://example.com/a,b\n第二行");
  assert.ok(bytes.toString("utf8").includes("中文"));
  assert.ok(!bytes.toString("utf8").includes("\\u4e2d"));
  // The stored baseline was written by Python text mode on Windows (CRLF).
  // The contract only mandates UTF-8 JSON; compare normalised line endings.
  assert.equal(bytes.toString("utf8").replace(/\r\n/g, "\n"), referenceText.replace(/\r\n/g, "\n"));
});

test("T5: zero rows produce header-only CSV and an empty JSON array", () => {
  assert.equal(serializeCsv([]).toString("utf8"), "﻿timestamp,status_code,length,file_type,url\r\n");
  assert.equal(serializeJson([]).toString("utf8"), "[]");
});

test("T5: internal source/rawTimestamp/indexId/rowId are never exported", () => {
  const records = baselineCsvRecords().map((record, index) => ({
    ...record,
    source: index === 0 ? "commoncrawl" : record.source,
    rawTimestamp: "20240102030405",
    indexId: "CC-MAIN-2024-42",
    rowId: `row-${index}`,
  }));
  const csv = serializeCsv(records).toString("utf8");
  const json = JSON.parse(serializeJson(records).toString("utf8"));
  assert.ok(!csv.includes("source"));
  assert.ok(!csv.includes("rawTimestamp"));
  assert.ok(!csv.includes("indexId"));
  assert.deepEqual(Object.keys(json[0]), FIELDS);
});

test("T5: export uses the filtered full snapshot, not a visible page", async () => {
  const transport = createFixtureTransport({ waybackFirstPage: "short" });
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const started = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await waitForTerminal(iut, started.value.jobId);
  const view = iut.getView(started.value.jobId, "wayback", { status: "200" }, {}, 0, 2);
  assert.equal(view.ok, true);
  if (!view.ok) return;
  const dir = new TempDir();
  try {
    const path = dir.file("filtered.csv");
    const exported = iut.exportResults({
      jobId: started.value.jobId,
      source: "wayback",
      expectedRevision: view.value.revision,
      filter: { status: "200" },
      format: "csv",
      path,
    });
    assert.equal(exported.ok, true);
    if (exported.ok) assert.equal(exported.value.count, view.value.matched);
    const rows = readFileSync(path, "utf8").replace(/^﻿/, "").trimEnd().split("\r\n");
    assert.equal(rows.length, view.value.matched + 1);
  } finally {
    dir.dispose();
  }
});

class GeneratedWaybackTransport implements Transport {
  calls: any[] = [];
  async fetchText(request: TransportRequest) {
    this.calls.push(request);
    if (request.kind !== "wayback-page") throw new Error(`unexpected ${request.kind}`);
    const page = request.page ?? 0;
    const sizes = [50, 50, 20];
    const count = sizes[page] ?? 0;
    if (!count) return { status: 200, text: "[]" };
    const offset = page === 0 ? 0 : page === 1 ? 50 : 100;
    const header = ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"];
    const rows = Array.from({ length: count }, (_, i) => {
      const index = offset + i;
      return [
        `com,example)/item/${index}`,
        "20240102030405",
        `https://example.com/item/${index}`,
        "text/html",
        index < 70 ? "200" : "404",
        `D${index}`,
        String(100 + index),
      ];
    });
    return { status: 200, text: JSON.stringify([header, ...rows]) };
  }
}

test("T5: 120 records filtered to 70 export all 70 across pages", async () => {
  const transport = new GeneratedWaybackTransport();
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const started = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await waitForTerminal(iut, started.value.jobId);
  const view = iut.getView(started.value.jobId, "wayback", { status: "200" }, {}, 3, 20);
  assert.equal(view.ok, true);
  if (!view.ok) return;
  assert.equal(view.value.matched, 70);
  assert.equal(view.value.pageCount, 4);

  const dir = new TempDir();
  try {
    const path = dir.file("120-70.csv");
    const exported = iut.exportResults({
      jobId: started.value.jobId,
      source: "wayback",
      expectedRevision: view.value.revision,
      filter: { status: "200" },
      format: "csv",
      path,
    });
    assert.equal(exported.ok, true);
    if (exported.ok) assert.equal(exported.value.count, 70);
    const lines = readFileSync(path, "utf8").replace(/^﻿/, "").trimEnd().split("\r\n");
    assert.equal(lines.length, 71);
  } finally {
    dir.dispose();
  }
});

test("T5: cancellation writes nothing and reports cancelled", async () => {
  const transport = createFixtureTransport({ waybackFirstPage: "short" });
  const dir = new TempDir();
  try {
    const iut = createIutUnderTest({ transport, clockUtc: CLOCK, cancelExport: () => true });
    const started = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    await waitForTerminal(iut, started.value.jobId);
    const view = iut.getView(started.value.jobId, "wayback");
    assert.equal(view.ok, true);
    if (!view.ok) return;
    const path = dir.file("cancelled.csv");
    const result = iut.exportResults({
      jobId: started.value.jobId,
      source: "wayback",
      expectedRevision: view.value.revision,
      format: "csv",
      path,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.cancelled, true);
      assert.equal(result.value.saved, false);
    }
    assert.throws(() => readFileSync(path));
  } finally {
    dir.dispose();
  }
});

test("T5: stale revision is rejected instead of exporting a different range", async () => {
  const transport = createFixtureTransport();
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const started = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await waitForTerminal(iut, started.value.jobId);
  const result = iut.exportResults({
    jobId: started.value.jobId,
    source: "wayback",
    expectedRevision: 0,
    format: "csv",
    path: new TempDir().file("stale.csv"),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "STALE_VIEW");
});

test("T5: write failure reports EXPORT and leaves no temp residue", () => {
  const dir = new TempDir();
  try {
    const target = dir.file("as-directory.csv");
    mkdirSync(target);
    assert.throws(() => writeExportAtomically(baselineCsvRecords(), target, "csv"));
    const leftovers = readdirSync(dir.path).filter((name: string) =>
      name.startsWith(".archrecon-acceptance-")
    );
    assert.deepEqual(leftovers, []);
  } finally {
    dir.dispose();
  }
});
