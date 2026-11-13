import test from "node:test";
import assert from "node:assert/strict";

import { createManager } from "../harness/production-helpers.ts";
import { fixedClock } from "../harness/test-utils.ts";

const CLOCK = fixedClock("specific natural month");
const HEADER = ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"];

function row(index: number): string[] {
  return [
    `com,example)/page0/${index}`,
    "20240102030405",
    `https://example.com/page0/${index}`,
    "text/html",
    "200",
    `D${index}`,
    String(index),
  ];
}

function cdx(rows: string[][]): string {
  return JSON.stringify([HEADER, ...rows]);
}

function transport() {
  const calls: string[] = [];
  return {
    calls,
    async fetch(url: string) {
      calls.push(url);
      const page = Number(new URL(url).searchParams.get("page") ?? "0");
      let text: string;
      if (page === 0) {
        const rows = Array.from({ length: 50 }, (_, index) => row(index));
        rows[10] = ["bad-row", "20240102030405", "https://example.com/bad", "text/html", "200", "D-bad"]; // 6 columns
        text = cdx(rows);
      } else if (page === 1) {
        text = cdx([
          ["k51", "20240103040506", "https://example.com/page1/1", "text/html", "200", "D51", "51"],
          ["k52", "20240104050607", "https://example.com/page1/2", "text/html", "200", "D52", "52"],
        ]);
      } else {
        text = "[]";
      }
      return { status: 200, text: async () => text, json: async () => JSON.parse(text) };
    },
  };
}

test("T3: a full Wayback page with one bad row still requests the next page", async () => {
  const fixture = transport();
  const harness = createManager(fixture as any, { clockUtc: CLOCK });
  const started = await harness.start({ target: "example.com", source: "wayback", range: { kind: "all" } });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const view = await harness.waitTerminal(started.value.jobId, "wayback");

  const pages = fixture.calls
    .map((url) => Number(new URL(url).searchParams.get("page") ?? "0"));
  assert.deepEqual(pages, [0, 1], "the adapter stopped after 49 parsed rows instead of using the raw 50-row page");
  assert.equal(view.unique, 51);
  assert.ok(view.reasons.some((reason: any) => reason.code === "parse_line" && reason.count === 1));
});
