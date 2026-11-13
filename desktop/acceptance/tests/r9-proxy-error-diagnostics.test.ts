import test from "node:test";
import assert from "node:assert/strict";

import { createManager } from "../harness/production-helpers.ts";
import { fixedClock } from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");

function response(text: string, status = 200) {
  return { status, text: async () => text, json: async () => JSON.parse(text) };
}

const COLLINFO = JSON.stringify([{
  id: "CC-MAIN-TEST",
  "cdx-api": "https://index.commoncrawl.org/CC-MAIN-TEST-index",
  from: "20240101000000",
  to: "20240301000000",
}]);

function transportWithPageCount(statusOrError: number | Error) {
  return {
    calls: [] as string[],
    async fetch(url: string) {
      this.calls.push(url);
      if (url.endsWith("/collinfo.json")) return response(COLLINFO);
      if (new URL(url).searchParams.get("showNumPages") === "true") {
        if (statusOrError instanceof Error) throw statusOrError;
        return response("rate limited", statusOrError);
      }
      return response('{"url":"https://example.com/a","status":"200","mime":"text/html","length":"1","timestamp":"20240102030405"}\n');
    },
  };
}

async function failureReason(statusOrError: number | Error) {
  const transport = transportWithPageCount(statusOrError);
  const harness = createManager(transport as any, { clockUtc: CLOCK });
  const started = await harness.start({
    target: "example.com",
    source: "commoncrawl",
    range: { kind: "month", year: 2024, month: 1 },
  });
  assert.equal(started.ok, true);
  if (!started.ok) throw new Error("start rejected");
  const view = await harness.waitTerminal(started.value.jobId, "commoncrawl");
  return { view, text: view.reasons.map((item: any) => `${item.code}:${item.message}`).join("\n") };
}

for (const status of [429, 503]) {
  test(`R9/diagnostics: CC page-count HTTP ${status} remains visible in the summary`, async () => {
    const { view, text } = await failureReason(status);
    assert.equal(view.status, "partial");
    assert.match(text, new RegExp(String(status)), `summary hid HTTP ${status}: ${text}`);
  });
}

test("R9/diagnostics: proxy connect error remains visible in the summary", async () => {
  const { text } = await failureReason(new Error("net::ERR_PROXY_CONNECTION_FAILED"));
  assert.match(text, /proxy|代理/i, `summary hid the proxy failure: ${text}`);
});

test("R9/diagnostics: TLS certificate error remains visible in the summary", async () => {
  const { text } = await failureReason(new Error("net::ERR_CERT_AUTHORITY_INVALID"));
  assert.match(text, /cert|tls|证书/i, `summary hid the TLS failure: ${text}`);
});

test("R9/diagnostics: timeout remains visible in the summary", async () => {
  const { text } = await failureReason(new Error("Request timed out after 30000ms"));
  assert.match(text, /timeout|超时/i, `summary hid the timeout: ${text}`);
});
