import test from "node:test";
import assert from "node:assert/strict";

import { createIutUnderTest, type Transport, type TransportRequest } from "../harness/iut.ts";
import { createFixtureTransport } from "../harness/fixture-transport.ts";
import { readFixtureJson, readFixtureText } from "../harness/fixtures.ts";
import {
  RecordingSink, fixedClock, sleep, waitFor, waitForTerminal,
} from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");

interface ProxyScenario {
  id: string;
  config: { mode: "direct" | "system" | "fixed"; url?: string; sourceEnv?: string };
  expected: Record<string, unknown>;
}

test("R5: events after window close are dropped without touching the sink", async () => {
  const transport = createFixtureTransport({ delay: { waybackPage: 0 } });
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const sink = new RecordingSink();
  iut.subscribe((event) => sink.deliver(event));
  const started = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await transport.waitForCall((call) => call.kind === "wayback-page");
  const beforeClose = sink.events.length;
  iut.close();
  await sleep(80);
  await iut.flushEvents();
  assert.equal(sink.events.length, beforeClose, "UI sink received events after close");
  assert.deepEqual(sink.errors, []);
  assert.equal(iut.getStatus(started.value.jobId), "stopped");
});

test("R5: stop then immediate restart keeps the two jobs independent", async () => {
  class RestartTransport implements Transport {
    calls: any[] = [];
    async fetchText(request: TransportRequest) {
      this.calls.push(request);
      await sleep(20);
      if (request.kind !== "wayback-page") throw new Error(`unexpected ${request.kind}`);
      // Job 1 keeps producing full pages so cancellation is not dependent on
      // the R2 final-page path; job 2 is a short, terminating page.
      const text = request.jobId === 1
        ? readFixtureText("sources/wayback_full_page.json")
        : readFixtureText("sources/wayback_page_0.json");
      return { status: 200, text };
    }
  }
  const transport = new RestartTransport();
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const sink = new RecordingSink();
  iut.subscribe((event) => sink.deliver(event));

  const first = iut.startQuery({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await waitFor(
    () => transport.calls.some((call) => call.kind === "wayback-page" && call.jobId === first.value.jobId),
    2000,
    "first Wayback page",
  );
  iut.cancelQuery(first.value.jobId, "wayback");
  assert.equal(await waitForTerminal(iut, first.value.jobId), "stopped");

  const second = iut.startQuery({ target: "other.example", source: "wayback", range: { kind: "all" } });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(await waitForTerminal(iut, second.value.jobId), "completed");
  await iut.flushEvents();

  assert.notEqual(first.value.jobId, second.value.jobId);
  const firstEvents = sink.events.filter((event) => event.jobId === first.value.jobId);
  const secondEvents = sink.events.filter((event) => event.jobId === second.value.jobId);
  assert.ok(firstEvents.length > 0);
  assert.ok(secondEvents.length > 0);
  assert.ok(secondEvents.every((event) => event.source === "wayback"));
  const secondView = iut.getView(second.value.jobId, "wayback");
  assert.equal(secondView.ok, true);
  if (secondView.ok) {
    assert.equal(secondView.value.scope.host, "other.example");
    assert.equal(secondView.value.status, "completed");
  }
});

test("R5/proxy: fixed proxy failure is an error and never falls back to direct", async () => {
  const transport = createFixtureTransport({ proxyFailure: true });
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  const started = iut.startQuery({
    target: "example.com",
    source: "wayback",
    range: { kind: "all" },
    proxy: { mode: "fixed", url: "http://127.0.0.1:18080" },
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(await waitForTerminal(iut, started.value.jobId), "failed");
  assert.equal(transport.directCalls.length, 0, "proxy failure silently retried direct");
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].proxy.mode, "fixed");
  const view = iut.getView(started.value.jobId, "wayback");
  assert.equal(view.ok, true);
  if (view.ok) {
    assert.ok(view.value.reasons.some((reason) => reason.includes("代理")));
  }
});

test("R5/proxy: proxy modes validate and the fixed URL is frozen with the task", async () => {
  const scenarios = readFixtureJson<ProxyScenario[]>("proxy/proxy-scenarios.json");
  const transport = createFixtureTransport();
  const iut = createIutUnderTest({ transport, clockUtc: CLOCK });
  for (const scenario of scenarios) {
    if (scenario.id === "proxy-connect-refused") continue;
    const started = iut.startQuery({
      target: "example.com",
      source: "wayback",
      range: { kind: "all" },
      proxy: scenario.config,
    });
    assert.equal(started.ok, true, `proxy scenario rejected: ${scenario.id}`);
    if (started.ok) {
      const config = iut.getFrozenConfig(started.value.jobId);
      assert.equal(config?.proxy.mode, scenario.config.mode);
      await waitForTerminal(iut, started.value.jobId);
    }
  }

  const invalid = iut.startQuery({
    target: "example.com",
    source: "wayback",
    range: { kind: "all" },
    proxy: { mode: "fixed", url: "ftp://127.0.0.1:1" },
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "INVALID_INPUT");
});
