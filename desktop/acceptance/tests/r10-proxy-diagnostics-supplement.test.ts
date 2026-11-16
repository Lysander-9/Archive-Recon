import test from "node:test";
import assert from "node:assert/strict";

import { createManager } from "../harness/production-helpers.ts";
import { fixedClock } from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");

function response(text: string, status = 200) {
  return { status, text: async () => text, json: async () => JSON.parse(text) };
}

const COLLINFO_TWO = JSON.stringify([
  {
    id: "CC-MAIN-FAIL",
    "cdx-api": "https://index.commoncrawl.org/CC-MAIN-FAIL-index",
    from: "20240101000000",
    to: "20240301000000",
  },
  {
    id: "CC-MAIN-OK",
    "cdx-api": "https://index.commoncrawl.org/CC-MAIN-OK-index",
    from: "20240101000000",
    to: "20240301000000",
  },
]);

function transportWithFailure(statusOrError: number | Error) {
  return {
    calls: [] as string[],
    async fetch(url: string) {
      this.calls.push(url);
      if (url.endsWith("/collinfo.json")) return response(COLLINFO_TWO);
      if (new URL(url).searchParams.get("showNumPages") === "true") {
        if (url.includes("CC-MAIN-OK")) return response(JSON.stringify({ pages: 1 }));
        if (statusOrError instanceof Error) throw statusOrError;
        return response("upstream failure", statusOrError);
      }
      if (url.includes("CC-MAIN-OK")) {
        return response(
          '{"url":"https://example.com/ok","status":"200","mime":"text/html","length":"1","timestamp":"20240102030405"}\n',
        );
      }
      return response("");
    },
  };
}

async function partialFailure(statusOrError: number | Error) {
  const transport = transportWithFailure(statusOrError);
  const harness = createManager(transport as any, { clockUtc: CLOCK });
  const started = await harness.start({
    target: "example.com",
    source: "commoncrawl",
    range: { kind: "month", year: 2024, month: 1 },
  });
  assert.equal(started.ok, true);
  if (!started.ok) throw new Error("start rejected");
  const view = await harness.waitTerminal(started.value.jobId, "commoncrawl");
  return {
    view,
    text: view.reasons.map((item: any) => `${item.code}:${item.message}`).join("\n"),
    contexts: view.reasons.map((item: any) => item.context),
  };
}

for (const status of [429, 502, 503, 504]) {
  test(`R10/diagnostics: HTTP ${status} visible while another index succeeds (partial)`, async () => {
    const { view, text, contexts } = await partialFailure(status);
    assert.equal(view.status, "partial");
    assert.equal(view.unique, 1);
    assert.match(text, new RegExp(String(status)), `summary hid HTTP ${status}: ${text}`);
    assert.ok(
      contexts.some((context: any) => context?.httpStatus === status),
      `structured httpStatus missing for ${status}: ${JSON.stringify(contexts)}`,
    );
  });
}

test("R10/diagnostics: retry attempts are bounded and visible", async () => {
  const { contexts } = await partialFailure(504);
  const attempts = contexts.map((context: any) => context?.attempts).filter((value: any) => typeof value === "number");
  assert.ok(attempts.length > 0, "attempts missing from context");
  assert.ok(Math.max(...attempts) <= 3, `retry count exceeded 3: ${attempts}`);
});

test("R10/diagnostics: real Chromium timeout cause is classified", async () => {
  const { text } = await partialFailure(new Error("net::ERR_TIMED_OUT"));
  assert.match(text, /timeout|timed out|超时/i, `summary hid timeout: ${text}`);
});

test("R10/diagnostics: real Chromium DNS cause is classified", async () => {
  const { text } = await partialFailure(new Error("net::ERR_NAME_NOT_RESOLVED"));
  assert.match(text, /dns|name|解析/i, `summary hid DNS: ${text}`);
});

test("R10/diagnostics: all indexes failing ends failed with the underlying status", async () => {
  const transport = transportWithFailure(504);
  // Remove the healthy companion by responding 504 for both indexes.
  const originalFetch = transport.fetch.bind(transport);
  transport.fetch = async (url: string) => {
    if (new URL(url).searchParams.get("showNumPages") === "true") {
      return response("gateway timeout", 504);
    }
    return originalFetch(url);
  };
  const harness = createManager(transport as any, { clockUtc: CLOCK });
  const started = await harness.start({
    target: "example.com",
    source: "commoncrawl",
    range: { kind: "month", year: 2024, month: 1 },
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "commoncrawl", 12_000);
  assert.equal(view.status, "failed");
  assert.match(view.reasons.map((item: any) => item.message).join("\n"), /504/);
});
