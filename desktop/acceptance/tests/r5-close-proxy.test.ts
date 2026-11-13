import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProxyConfig,
  proxySnapshot,
} from "../harness/generated/production.mjs";
import { createFixtureTransport, createManager } from "../harness/production-helpers.ts";
import { fixedClock, sleep } from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");

test("R5: closeAll cancels the job and stops UI event delivery", async () => {
  const transport = createFixtureTransport({ wayback: "short", delay: { waybackPage: 0 } });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  await transport.waitForCall((call) => call.kind === "wayback-page");
  const before = harness.events.length;
  harness.manager.closeAll();
  await sleep(100);
  assert.equal(harness.events.length, before, "events were emitted after close");
  const view = harness.view(started.value.jobId, "wayback");
  assert.equal(view.ok, true);
  if (view.ok) {
    assert.equal(view.value.status, "stopped");
    assert.equal(view.value.terminal, true);
  }
});

test("R5: stop then immediate restart keeps jobs and events independent", async () => {
  const transport = createFixtureTransport({ wayback: "short", delay: { waybackPage: 0 } });
  const harness = createManager(transport, { clockUtc: CLOCK });
  const first = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await transport.waitForCall((call) => call.kind === "wayback-page" && call.page === 0);
  harness.manager.cancel({ jobId: first.value.jobId, source: "wayback" });
  const firstView = await harness.waitTerminal(first.value.jobId, "wayback");
  assert.equal(firstView.status, "stopped");

  const second = await harness.start({ target: "other.example", source: "wayback", range: { kind: "all" } });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const secondView = await harness.waitTerminal(second.value.jobId, "wayback");
  assert.equal(secondView.status, "completed");
  assert.equal(secondView.scope.host, "other.example");
  assert.notEqual(first.value.jobId, second.value.jobId);
  const secondEvents = harness.events.filter((event) => event.jobId === second.value.jobId);
  assert.ok(secondEvents.length > 0);
  assert.ok(secondEvents.every((event) => event.source === "wayback"));
});

test("R5/proxy: proxy config validation never downgrades an invalid fixed proxy", () => {
  assert.deepEqual(buildProxyConfig({ mode: "direct" }), { mode: "direct" });
  assert.deepEqual(buildProxyConfig({ mode: "system" }), { mode: "system" });
  assert.deepEqual(buildProxyConfig({ mode: "fixed", server: "http://127.0.0.1:18080" }), {
    mode: "fixed_servers",
    proxyRules: "http://127.0.0.1:18080",
  });
  assert.deepEqual(buildProxyConfig({ mode: "fixed", server: "socks5://127.0.0.1:1080" }), {
    mode: "fixed_servers",
    proxyRules: "socks5://127.0.0.1:1080",
  });
  for (const server of ["", "127.0.0.1:8080", "ftp://127.0.0.1:21", "http://user:pass@127.0.0.1:8080/extra"]) {
    assert.throws(() => buildProxyConfig({ mode: "fixed", server }), (error: any) => error.code === "PROXY");
  }
});

test("R5/proxy: proxy snapshot redacts credentials", () => {
  const snapshot = proxySnapshot({ mode: "fixed", server: "http://user:secret@127.0.0.1:8080" });
  assert.equal(snapshot.mode, "fixed");
  assert.ok(!snapshot.display.includes("secret"));
  assert.ok(!snapshot.display.includes("user"));
  assert.equal(proxySnapshot({ mode: "direct" }).display, "直连");
  assert.equal(proxySnapshot({ mode: "system" }).display, "系统代理");
});
