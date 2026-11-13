import test from "node:test";
import assert from "node:assert/strict";

import { createIutUnderTest, matchDomainPattern, normalizeTarget } from "../harness/iut.ts";
import { createFixtureTransport } from "../harness/fixture-transport.ts";
import { fixedClock, waitForTerminal } from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");

function waybackParams(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

test("T1: valid target forms normalize to a frozen domain scope", () => {
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
    assert.equal(result.ok, true, `expected ${input} to be accepted`);
    if (result.ok) {
      assert.equal(result.value.host, host);
      assert.equal(result.value.wildcard, wildcard);
      assert.equal(result.value.match, "domain");
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
    if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
  }
});

test("T1: rejected targets never reach the transport", async () => {
  const transport = createFixtureTransport();
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  for (const target of ["user:pass@example.com", "exa mple.com", "example.com/path"]) {
    const result = iut.startQuery({ target, source: "wayback", range: { kind: "all" } });
    assert.equal(result.ok, false, `accepted unexpectedly: ${target}`);
  }
  assert.equal(transport.calls.length, 0);
});

test("T1: plain and wildcard input freeze the same host scope", async () => {
  const transport = createFixtureTransport({ pageCount: 1 });
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const plain = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(plain.ok, true);
  if (!plain.ok) return;
  await waitForTerminal(iut, plain.value.jobId);

  const wildcard = iut.startQuery({ target: "*.example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(wildcard.ok, true);
  if (!wildcard.ok) return;
  await waitForTerminal(iut, wildcard.value.jobId);

  assert.equal(plain.value.frozenScope.host, "example.com");
  assert.equal(wildcard.value.frozenScope.host, "example.com");
  assert.equal(wildcard.value.frozenScope.wildcard, true);
});

test("T1: Wayback request uses domain matching and urlkey collapse", async () => {
  const transport = createFixtureTransport();
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const started = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await waitForTerminal(iut, started.value.jobId);

  const call = transport.callsOfKind("wayback-page")[0];
  const params = waybackParams(call.url);
  assert.equal(params.get("url"), "example.com");
  assert.equal(params.get("matchType"), "domain");
  assert.equal(params.get("collapse"), "urlkey");
  assert.equal(params.get("limit"), "50");
});

test("T1: Common Crawl request uses the wildcard host alias and block pageSize", async () => {
  const transport = createFixtureTransport({ pageCount: 1 });
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const started = iut.startQuery({ target: "example.com", source: "commoncrawl", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await waitForTerminal(iut, started.value.jobId);

  const countCall = transport.callsOfKind("cc-page-count")[0];
  const countParams = waybackParams(countCall.url);
  assert.equal(countParams.get("url"), "*.example.com");
  assert.equal(countParams.get("pageSize"), "5");
  assert.equal(countParams.get("showNumPages"), "true");

  const pageCall = transport.callsOfKind("cc-page")[0];
  const pageParams = waybackParams(pageCall.url);
  assert.equal(pageParams.get("url"), "*.example.com");
  assert.equal(pageParams.get("pageSize"), "5");
});

test("T1: result domain filter matches root and subdomains, excludes lookalikes", () => {
  assert.equal(matchDomainPattern("example.com", "example.com"), true);
  assert.equal(matchDomainPattern("www.example.com", "example.com"), true);
  assert.equal(matchDomainPattern("a.b.example.com", "example.com"), true);
  assert.equal(matchDomainPattern("badexample.com", "example.com"), false);
  assert.equal(matchDomainPattern("example.com.evil.com", "example.com"), false);
  assert.equal(matchDomainPattern("example.com", "*.example.com"), true);
  assert.equal(matchDomainPattern("cdn.example.com", "https://example.com/"), true);
});
