import test from "node:test";
import assert from "node:assert/strict";

import { CHANNELS, EMPTY_FILTER, validateCopyReasons } from "../harness/generated/production.mjs";
import { createManager } from "../harness/production-helpers.ts";
import { fixedClock } from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");
const HEADER = ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"];

function cdxRows(count: number, prefix = "item"): string[][] {
  return Array.from({ length: count }, (_, index) => [
    `com,example)/${prefix}/${index}`,
    "20240102030405",
    `https://example.com/${prefix}/${index}`,
    "text/html",
    "200",
    `D${index}`,
    String(index),
  ]);
}

function response(text: string) {
  return { status: 200, text: async () => text, json: async () => JSON.parse(text) };
}

test("R7/budget: task record budget truncates, keeps records and reports partial", async () => {
  const transport = {
    calls: [] as string[],
    async fetch(url: string) {
      this.calls.push(url);
      return response(JSON.stringify([HEADER, ...cdxRows(3)]));
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
  assert.equal(view.status, "partial");
  assert.equal(view.completion, "partial");
  const reason = view.reasons.find((item: any) => item.code === "record_limit");
  assert.ok(reason, "record_limit reason missing");
  assert.equal(reason.count, 1);
  assert.match(reason.message, /记录预算/);
});

test("R7/budget: oversized response keeps earlier data and reports the byte limit", async () => {
  const transport = {
    calls: [] as string[],
    async fetch(url: string) {
      this.calls.push(url);
      const page = Number(new URL(url).searchParams.get("page") ?? "0");
      if (page === 0) return response(JSON.stringify([HEADER, ...cdxRows(50, "page0")]));
      return response("x".repeat(30_000));
    },
  };
  const harness = createManager(transport as any, {
    clockUtc: CLOCK,
    budgets: { maxResponseBytes: 20_000 },
  });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "wayback");
  assert.equal(view.unique, 50);
  assert.equal(view.status, "partial");
  assert.ok(
    view.reasons.some((item: any) => item.code === "record_limit" && /第 2 页响应超过/.test(item.message)),
    "page-level byte-limit reason missing",
  );
  assert.ok(
    !view.reasons.some((item: any) => item.code === "network"),
    "byte limit must not be reported as network",
  );
});

const MALICIOUS_COLLINFO = JSON.stringify([
  {
    id: "CC-MAIN-VALID",
    "cdx-api": "https://index.commoncrawl.org/CC-MAIN-VALID-index",
    from: "2024-10-03T09:40:20",
    to: "2024-10-16T09:12:31",
  },
  {
    id: "CC-MAIN-EVIL-HOST",
    "cdx-api": "https://evil.example/CC-MAIN-EVIL-HOST-index",
    from: "2024-10-03T09:40:20",
    to: "2024-10-16T09:12:31",
  },
  {
    id: "CC-MAIN-EVIL-HTTP",
    "cdx-api": "http://index.commoncrawl.org/CC-MAIN-EVIL-HTTP-index",
    from: "2024-10-03T09:40:20",
    to: "2024-10-16T09:12:31",
  },
  {
    id: "CC-MAIN-EVIL-SUFFIX",
    "cdx-api": "https://index.commoncrawl.org.evil.example/CC-MAIN-EVIL-SUFFIX-index",
    from: "2024-10-03T09:40:20",
    to: "2024-10-16T09:12:31",
  },
]);

test("R7/endpoint: non-official cdx-api entries are rejected with a visible count", async () => {
  const transport = {
    calls: [] as string[],
    async fetch(url: string) {
      this.calls.push(url);
      if (url.endsWith("/collinfo.json")) return response(MALICIOUS_COLLINFO);
      if (new URL(url).searchParams.get("showNumPages") === "true") {
        return response(JSON.stringify({ pages: 1 }));
      }
      if (url.includes("-index")) {
        return response(JSON.stringify({
          url: "https://example.com/cc/one",
          status: "200",
          mime: "text/html",
          length: "1",
          timestamp: "20240102030405",
        }));
      }
      throw new Error(`unexpected URL ${url}`);
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
  const reason = view.reasons.find((item: any) => item.code === "range_unknown");
  assert.ok(reason);
  assert.equal(reason.count, 3);
  assert.match(reason.message, /缺失\/非法/);
  assert.ok(!transport.calls.some((url) => url.includes("evil.example")));
  assert.ok(!transport.calls.some((url) => url.startsWith("http://index.commoncrawl.org")));
});

test("R7/metadata: malformed cdx entries count toward range_unknown even when valid indexes exist", async () => {
  const payload = JSON.parse(MALICIOUS_COLLINFO);
  payload.push({
    id: "CC-MAIN-MISSING-API",
    from: "2024-10-03T09:40:20",
    to: "2024-10-16T09:12:31",
  });
  const transport = {
    calls: [] as string[],
    async fetch(url: string) {
      this.calls.push(url);
      if (url.endsWith("/collinfo.json")) return response(JSON.stringify(payload));
      if (new URL(url).searchParams.get("showNumPages") === "true") {
        return response(JSON.stringify({ pages: 1 }));
      }
      return response("");
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
  const reason = view.reasons.find((item: any) => item.code === "range_unknown");
  assert.ok(reason);
  assert.equal(reason.count, 4);
});

test("R7/copy: copyReasons and copySelection enforce jobId/source/revision", async () => {
  const transport = {
    calls: [] as string[],
    async fetch(url: string) {
      this.calls.push(url);
      if (url.endsWith("/collinfo.json")) {
        return response(JSON.stringify([{
          id: "CC-MAIN-TEST",
          "cdx-api": "https://index.commoncrawl.org/CC-MAIN-TEST-index",
          from: "2024-10-03T09:40:20",
          to: "2024-10-16T09:12:31",
        }]));
      }
      if (new URL(url).searchParams.get("showNumPages") === "true") {
        return response(JSON.stringify({ pages: 1 }));
      }
      return response([
        '{"url":"https://example.com/ok","status":"200","mime":"text/html","length":"1","timestamp":"20240102030405"}',
        "this line is not valid JSON",
      ].join("\n"));
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

  const reasons = harness.manager.copyReasons({
    jobId: started.value.jobId,
    source: "commoncrawl",
    revision: view.revision,
  });
  assert.equal(reasons.ok, true);
  if (reasons.ok) {
    assert.ok(reasons.value.outcome.reasonCount >= 1);
    assert.match(reasons.value.text, /parse_line/);
  }
  const staleReasons = harness.manager.copyReasons({
    jobId: started.value.jobId,
    source: "commoncrawl",
    revision: view.revision + 1,
  });
  assert.equal(staleReasons.ok, false);
  if (!staleReasons.ok) assert.equal(staleReasons.error.code, "STALE_VIEW");
  const wrongSourceReasons = harness.manager.copyReasons({
    jobId: started.value.jobId,
    source: "wayback",
    revision: view.revision,
  });
  assert.equal(wrongSourceReasons.ok, false);

  const rowIds = view.rows.map((row: any) => row.rowId);
  const copied = harness.manager.copy({
    jobId: started.value.jobId,
    source: "commoncrawl",
    revision: view.revision,
    rowIds,
    mode: "url",
  });
  assert.equal(copied.ok, true);
  const staleCopy = harness.manager.copy({
    jobId: started.value.jobId,
    source: "commoncrawl",
    revision: view.revision - 1,
    rowIds,
    mode: "url",
  });
  assert.equal(staleCopy.ok, false);
});

test("R7/interesting: RowView exposes shared sensitive-path flag", async () => {
  const rows = [
    ["k1", "20240102030405", "https://example.com/.env", "text/plain", "200", "D1", "1"],
    ["k2", "20240102030405", "https://example.com/plain", "text/html", "200", "D2", "1"],
  ];
  const transport = {
    calls: [] as string[],
    async fetch(url: string) {
      this.calls.push(url);
      return response(JSON.stringify([HEADER, ...rows]));
    },
  };
  const harness = createManager(transport as any, { clockUtc: CLOCK });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "wayback");
  const env = view.rows.find((row: any) => row.url.endsWith("/.env"));
  const plain = view.rows.find((row: any) => row.url.endsWith("/plain"));
  assert.equal(env.interesting, true);
  assert.equal(plain.interesting, false);
});

test("R7/copy: copyReasons IPC validator rejects arbitrary/invalid payloads", () => {
  const valid = validateCopyReasons({ jobId: 1, source: "wayback", revision: 0 });
  assert.equal(valid.ok, true);
  const invalidPayloads = [
    null,
    {},
    { jobId: 0, source: "wayback", revision: 0 },
    { jobId: 1, source: "other", revision: 0 },
    { jobId: 1, source: "wayback", revision: -1 },
    { jobId: 1, source: "wayback", revision: "0" },
    { jobId: 1, source: "wayback", revision: 0, text: "arbitrary" },
  ];
  for (const payload of invalidPayloads) {
    const result = validateCopyReasons(payload);
    if (payload && (payload as any).text !== undefined) {
      // Extra fields are not a clipboard payload; the validator only reads the
      // three allowed keys and never accepts caller-supplied text.
      assert.equal(result.ok, true);
      assert.deepEqual(Object.keys((result as any).value).sort(), ["jobId", "revision", "source"]);
    } else {
      assert.equal(result.ok, false, `accepted invalid payload ${JSON.stringify(payload)}`);
    }
  }
});

test("R7/copy: IPC channel surface remains a fixed whitelist", () => {
  const channels = Object.values(CHANNELS) as string[];
  for (const name of [
    "archive:startQuery", "archive:cancelQuery", "archive:getView",
    "archive:exportResults", "archive:copySelection", "archive:copyReasons",
    "archive:themeGet", "archive:themeChanged", "archive:jobEvent",
  ]) {
    assert.ok(channels.includes(name), `missing channel ${name}`);
  }
  assert.ok(!channels.some((name) => /clipboard|writeText|execCommand|arbitrary/i.test(name)));
});
