import test from "node:test";
import assert from "node:assert/strict";

import { createManager } from "../harness/production-helpers.ts";
import { fixedClock } from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");
const HEADER = ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"];

function response(text: string) {
  return { status: 200, text: async () => text, json: async () => JSON.parse(text) };
}

function row(url: string, key: string): string[] {
  return [`com,example)/${key}`, "20240102030405", url, "text/html", "200", key, "1"];
}

function duplicateRows(): string[][] {
  return [
    row("https://example.com/a", "a"),
    row("https://example.com/a", "a2"),
    row("https://example.com/b", "b"),
    row("https://example.com/c", "c"),
  ];
}

test("R7/budget: same-batch duplicates do not consume quota or count as lost", async () => {
  const transport = {
    calls: [] as string[],
    async fetch(url: string) {
      this.calls.push(url);
      return response(JSON.stringify([HEADER, ...duplicateRows()]));
    },
  };
  const harness = createManager(transport as any, {
    clockUtc: CLOCK,
    budgets: { maxTaskRecords: 2 },
  });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "wayback");
  assert.equal(view.unique, 2, "A and B must fit the quota");
  assert.equal(view.received, 4, "received must reflect the raw batch size");
  const reason = view.reasons.find((item: any) => item.code === "record_limit");
  assert.ok(reason);
  assert.equal(reason.count, 1, "only unique C is over budget");
  assert.equal(view.status, "partial");
});

test("R7/budget: exactly at the limit does not report record_limit", async () => {
  const transport = {
    calls: [] as string[],
    async fetch(url: string) {
      this.calls.push(url);
      return response(JSON.stringify([HEADER, ...duplicateRows().slice(2, 4)]));
    },
  };
  const harness = createManager(transport as any, {
    clockUtc: CLOCK,
    budgets: { maxTaskRecords: 2 },
  });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "wayback");
  assert.equal(view.unique, 2);
  assert.equal(view.received, 2);
  assert.ok(!view.reasons.some((item: any) => item.code === "record_limit"));
  assert.equal(view.status, "completed");
});

const NDJSON_A = '{"url":"https://example.com/a","status":"200","mime":"text/html","length":"1","timestamp":"20240102030405"}';
const NDJSON_B = '{"url":"https://example.com/b","status":"200","mime":"text/html","length":"1","timestamp":"20240102030405"}';

function twoIndexTransport(pages: Record<string, string>) {
  return {
    calls: [] as string[],
    async fetch(url: string) {
      this.calls.push(url);
      if (url.endsWith("/collinfo.json")) {
        return response(JSON.stringify([
          {
            id: "CC-MAIN-A",
            "cdx-api": "https://index.commoncrawl.org/CC-MAIN-A-index",
            from: "2024-10-03T09:40:20",
            to: "2024-10-16T09:12:31",
          },
          {
            id: "CC-MAIN-B",
            "cdx-api": "https://index.commoncrawl.org/CC-MAIN-B-index",
            from: "2024-10-03T09:40:20",
            to: "2024-10-16T09:12:31",
          },
        ]));
      }
      if (new URL(url).searchParams.get("showNumPages") === "true") {
        return response(JSON.stringify({ pages: 1 }));
      }
      const indexId = url.includes("CC-MAIN-A") ? "CC-MAIN-A" : "CC-MAIN-B";
      return response(pages[indexId] ?? "");
    },
  };
}

test("R7/budget: cross-batch duplicates do not consume quota or report loss", async () => {
  const transport = twoIndexTransport({
    "CC-MAIN-A": `${NDJSON_A}\n${NDJSON_B}`,
    "CC-MAIN-B": `${NDJSON_A}\n${NDJSON_A}`,
  });
  const harness = createManager(transport as any, {
    clockUtc: CLOCK,
    budgets: { maxTaskRecords: 2 },
  });
  const started = await harness.start({
    target: "example.com",
    source: "commoncrawl",
    range: { kind: "month", year: 2024, month: 10 },
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "commoncrawl");
  assert.equal(view.unique, 2);
  assert.equal(view.received, 4);
  assert.ok(!view.reasons.some((item: any) => item.code === "record_limit"));
});

test("R7/budget: a new URL over full quota reports record_limit once", async () => {
  const transport = twoIndexTransport({
    "CC-MAIN-A": `${NDJSON_A}\n${NDJSON_B}`,
    "CC-MAIN-B": `${NDJSON_A}\n{"url":"https://example.com/c","status":"200","mime":"text/html","length":"1","timestamp":"20240102030405"}`,
  });
  const harness = createManager(transport as any, {
    clockUtc: CLOCK,
    budgets: { maxTaskRecords: 2 },
  });
  const started = await harness.start({
    target: "example.com",
    source: "commoncrawl",
    range: { kind: "month", year: 2024, month: 10 },
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "commoncrawl");
  assert.equal(view.unique, 2);
  assert.equal(view.received, 4);
  const reason = view.reasons.find((item: any) => item.code === "record_limit");
  assert.ok(reason);
  assert.equal(reason.count, 1);
});

test("R7/collinfo: invalid JSON/non-array becomes visible range_unknown partial", async () => {
  for (const body of ["not-json", "{}"]) {
    const transport = {
      calls: [] as string[],
      async fetch(url: string) {
        this.calls.push(url);
        return response(body);
      },
    };
    const harness = createManager(transport as any, { clockUtc: CLOCK });
    const started = await harness.start({
      target: "example.com",
      source: "commoncrawl",
      range: { kind: "month", year: 2024, month: 10 },
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const view = await harness.waitTerminal(started.value.jobId, "commoncrawl");
    assert.equal(view.status, "partial");
    assert.ok(
      view.reasons.some((item: any) => item.code === "range_unknown" && /无法解析|不是索引数组/.test(item.message)),
      `missing collinfo parse reason for ${body}`,
    );
  }
});

test("R7/redirect: a redirect to a non-official endpoint is rejected before follow", async () => {
  const transport = {
    calls: [] as string[],
    async fetch(url: string) {
      this.calls.push(url);
      return {
        status: 302,
        location: "https://evil.example/collinfo.json",
        text: async () => "",
        json: async () => ({}),
      };
    },
  };
  const harness = createManager(transport as any, { clockUtc: CLOCK });
  const started = await harness.start({
    target: "example.com",
    source: "commoncrawl",
    range: { kind: "month", year: 2024, month: 10 },
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "commoncrawl");
  assert.equal(view.status, "failed");
  assert.equal(transport.calls.length, 1, "redirect target must not be requested");
  assert.ok(
    view.reasons.some((item: any) => item.code === "network" && /重定向/.test(item.message)),
    "redirect rejection reason missing",
  );
});
