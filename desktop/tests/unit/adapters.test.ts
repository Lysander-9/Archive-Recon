import { expect, test } from "@playwright/test";

import { AppError } from "../../src/application/errors";
import type { RequestOptions } from "../../src/application/ports";
import { CommonCrawlAdapter } from "../../src/main/adapters/commoncrawl";
import { buildProxyConfig, proxySnapshot } from "../../src/main/adapters/proxy";
import { WaybackAdapter } from "../../src/main/adapters/wayback";
import { fetchText } from "../../src/main/adapters/http";
import { parseCcIndex } from "../../src/domain/time";
import { fakeTransport, jsonResponse, textResponse } from "../support/builders";

function options(transport: RequestOptions["transport"], signal?: AbortSignal): RequestOptions {
  return { transport, signal: signal ?? new AbortController().signal, timeoutMs: 1000 };
}

test.describe("Wayback adapter", () => {
  test("parses rows, keeps valid ones and counts malformed rows", async () => {
    const payload = [
      ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
      ["k1", "20240102030405", "https://example.com/a", "text/html; charset=utf-8", "200", "D", "10"],
      ["k2", "20240103040506"],
      ["k3", "20240104050607", "https://example.com/c", "text/css", "404", "D", "0"],
    ];
    const { transport, urls } = fakeTransport([jsonResponse(payload)]);
    const adapter = new WaybackAdapter({ baseUrl: "http://127.0.0.1:9/cdx" });

    const result = await adapter.queryPage("example.com", 0, 50, options(transport));

    expect(result.records).toHaveLength(2);
    expect(result.records[0].fileType).toBe("text/html");
    expect(result.records[0].timestamp).toBe("2024-01-02");
    expect(result.records[0].rawTimestamp).toBe("20240102030405");
    expect(result.parseSkipped).toBe(1);
    expect(urls[0]).toContain("matchType=domain");
    expect(urls[0]).toContain("collapse=urlkey");
    expect(urls[0]).toContain("limit=50");
  });

  test("non-array payload is reported instead of silently empty", async () => {
    const { transport } = fakeTransport([jsonResponse({ error: "unexpected" })]);
    const adapter = new WaybackAdapter({ baseUrl: "http://127.0.0.1:9/cdx" });

    const result = await adapter.queryPage("example.com", 0, 50, options(transport));

    expect(result.records).toEqual([]);
    expect(result.reasons[0].code).toBe("parse_record");
  });
});

test.describe("Common Crawl adapter", () => {
  const collinfo = [
    {
      id: "CC-MAIN-2024-10",
      "cdx-api": "http://127.0.0.1:9/cc/CC-MAIN-2024-10-index",
      from: "20240101000000",
      to: "20240301000000",
    },
    { id: "broken", "cdx-api": "http://127.0.0.1:9/cc/broken-index" },
  ];

  test("reads official collinfo metadata and queries the given cdx-api", async () => {
    const ndjson = [
      '{"url":"https://example.com/a","status":"200","mime":"text/html; charset=UTF-8","length":"1","timestamp":"20240102030405"}',
      "not json",
      '{"url":"https://example.com/b","status":"301","mime":"text/html","length":"2","timestamp":"20240103040506"}',
    ].join("\n");
    const { transport, urls } = fakeTransport([
      jsonResponse(collinfo),
      jsonResponse({ pages: 3 }),
      textResponse(ndjson),
      textResponse(ndjson),
    ]);
    const adapter = new CommonCrawlAdapter({ indexBaseUrl: "http://127.0.0.1:9/cc" });

    const { metas } = await adapter.fetchIndexes(options(transport));
    expect(metas).toHaveLength(2);
    expect(metas[0].unknown).toBe(false);
    expect(metas[1].unknown).toBe(true);

    const pages = await adapter.pageCount(metas[0], "example.com", options(transport));
    expect(pages).toBe(3);
    expect(urls[1]).toContain("showNumPages=true");
    expect(urls[1]).toContain("url=*.example.com");

    const page = await adapter.queryPage(metas[0], "example.com", 0, 5, options(transport));
    expect(page.records).toHaveLength(2);
    expect(page.records[0].fileType).toBe("text/html");
    expect(page.records[0].indexId).toBe("CC-MAIN-2024-10");
    expect(page.parseSkipped).toBe(1);
    expect(page.reasons[0].code).toBe("parse_line");
    expect(urls[2]).toContain("pageSize=5");
  });

  test("page selection only uses official metadata", () => {
    const meta = parseCcIndex(collinfo[0])!;
    // An id like 2024-10 says nothing about the month; only `from`/`to` do.
    expect(meta.fromMs).toBe(Date.UTC(2024, 0, 1));
  });
});

test.describe("proxy isolation", () => {
  test("builds direct, system and fixed configs", () => {
    expect(buildProxyConfig({ mode: "direct" })).toEqual({ mode: "direct" });
    expect(buildProxyConfig({ mode: "system" })).toEqual({ mode: "system" });
    expect(buildProxyConfig({ mode: "fixed", server: "http://127.0.0.1:7890" })).toEqual({
      mode: "fixed_servers",
      proxyRules: "http://127.0.0.1:7890",
    });
  });

  test("rejects malformed fixed proxies without falling back to direct", () => {
    expect(() => buildProxyConfig({ mode: "fixed", server: "127.0.0.1:7890" })).toThrow(AppError);
    expect(() => buildProxyConfig({ mode: "fixed", server: "" })).toThrow(AppError);
  });

  test("redacts credentials in the displayed snapshot", () => {
    const snapshot = proxySnapshot({ mode: "fixed", server: "http://user:secret@127.0.0.1:7890" });
    expect(snapshot.display).not.toContain("secret");
    expect(snapshot.display).not.toContain("user:");
    expect(snapshot.server).toContain("user:secret");
  });
});

test.describe("HTTP deadline", () => {
  test("aborts a hanging request with TIMEOUT", async () => {
    const controller = new AbortController();
    const transport = (
      _url: string,
      init?: { signal?: AbortSignal },
    ): Promise<never> =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    await expect(
      fetchText(transport, "http://example.invalid/", {
        transport,
        signal: controller.signal,
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
