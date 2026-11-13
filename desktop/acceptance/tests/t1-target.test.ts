import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTarget, matchDomainPattern, matchDomainPatterns } from "../harness/generated/production.mjs";
import { createFixtureTransport, createManager } from "../harness/production-helpers.ts";
import { fixedClock } from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");

test("T1: valid target forms normalize to a frozen host-and-subdomains scope", () => {
  const cases: [string, string, boolean][] = [
    ["example.com", "example.com", false],
    ["EXAMPLE.com", "example.com", false],
    ["*.example.com", "example.com", true],
    ["https://Example.com/", "example.com", false],
    ["http://example.com", "example.com", false],
    ["https://*.example.com/", "example.com", true],
    [" example.com ", "example.com", false],
  ];
  for (const [input, host, wildcard] of cases) {
    const result = normalizeTarget(input);
    assert.equal(result.ok, true, `expected ${input} to be accepted: ${JSON.stringify(result)}`);
    if (result.ok) {
      assert.equal(result.scope.host, host);
      assert.equal(result.scope.wildcard, wildcard);
      assert.equal(result.scope.match, "host-and-subdomains");
    }
  }
});

test("T1: path/query/fragment/port/userinfo/whitespace/percent/backslash are rejected", () => {
  const invalid = [
    "",
    "   ",
    "example.com/path",
    "example.com?x=1",
    "example.com#frag",
    "example.com:8080",
    "example.com:bad",
    "ftp://example.com",
    "http://",
    "example.com.",
    "-bad.example.com",
    "bad-.example.com",
    "user:pass@example.com",
    "https://user:pass@example.com/",
    "exa mple.com",
    "example .com",
    "https://example.com\\@evil.test",
    "exa%6Dple.com",
  ];
  for (const input of invalid) {
    const result = normalizeTarget(input);
    assert.equal(result.ok, false, `accepted unexpectedly: ${JSON.stringify(input)}`);
  }
});

test("T1: rejected targets never create a job session or transport call", async () => {
  const transport = createFixtureTransport();
  const harness = createManager(transport, { clockUtc: CLOCK });
  for (const target of ["user:pass@example.com", "exa mple.com", "example.com/path"]) {
    const result = await harness.start({ target, source: "wayback", range: { kind: "all" } });
    assert.equal(result.ok, false, `accepted unexpectedly: ${target}`);
  }
  assert.equal(harness.sessions.created.length, 0);
  assert.equal(transport.calls.length, 0);
});

test("T1: Wayback request uses domain matching and urlkey collapse", async () => {
  const transport = createFixtureTransport({ wayback: "short" });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await harness.waitTerminal(started.value.jobId, "wayback");
  const call = transport.callsOfKind("wayback-page")[0];
  const params = new URL(call.url).searchParams;
  assert.equal(params.get("url"), "example.com");
  assert.equal(params.get("matchType"), "domain");
  assert.equal(params.get("collapse"), "urlkey");
  assert.equal(params.get("limit"), "50");
});

test("T1: Common Crawl request uses wildcard host and block pageSize", async () => {
  const transport = createFixtureTransport({ collinfo: "selected", pageCount: 1 });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const started = await harness.start({
    target: "example.com",
    source: "commoncrawl",
    range: { kind: "month", year: 2024, month: 10 },
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await harness.waitTerminal(started.value.jobId, "commoncrawl");

  const countCall = transport.callsOfKind("cc-page-count")[0];
  const countParams = new URL(countCall.url).searchParams;
  assert.equal(countParams.get("url"), "*.example.com");
  assert.equal(countParams.get("pageSize"), "5");
  assert.equal(countParams.get("showNumPages"), "true");

  const pageCall = transport.callsOfKind("cc-page")[0];
  const pageParams = new URL(pageCall.url).searchParams;
  assert.equal(pageParams.get("url"), "*.example.com");
  assert.equal(pageParams.get("pageSize"), "5");
});

test("T1: result domain filter matches root/subdomains and excludes lookalikes", () => {
  assert.equal(matchDomainPattern("example.com", "example.com"), true);
  assert.equal(matchDomainPattern("www.example.com", "example.com"), true);
  assert.equal(matchDomainPattern("a.b.example.com", "example.com"), true);
  assert.equal(matchDomainPattern("badexample.com", "example.com"), false);
  assert.equal(matchDomainPattern("example.com.evil.com", "example.com"), false);
  assert.equal(matchDomainPattern("cdn.example.com", "*.example.com"), true);
  assert.equal(matchDomainPatterns("https://www.example.com/a", ["example.com"], ["cdn.example.com"]), true);
});
