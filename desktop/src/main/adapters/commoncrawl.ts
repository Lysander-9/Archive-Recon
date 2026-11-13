/**
 * Common Crawl Index adapter: selects indexes by official cdx-api from/to metadata,
 * never by parsing an index id or name. pageSize counts compressed index blocks.
 */

import type { CommonCrawlPort, PageResult, RequestOptions } from "../../application/ports";
import type { ReasonDto } from "../../contracts/types";
import { AppError } from "../../application/errors";
import { parseCcIndex, type CcIndexMeta } from "../../domain/time";
import { formatTimestamp, type RawArchiveRecord } from "../../domain/record";
import { fetchText } from "./http";

export const DEFAULT_CC_BASE = "https://index.commoncrawl.org";

interface CommonCrawlAdapterOptions {
  indexBaseUrl?: string;
  /** Test-only: allow http cdx-api endpoints on the same origin as indexBaseUrl. */
  allowInsecureCdxApi?: boolean;
}

function withParams(urlText: string, params: Record<string, string>): string {
  const url = new URL(urlText);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function parseNdjson(
  text: string,
  indexId: string,
  page: number,
): { records: RawArchiveRecord[]; reasons: ReasonDto[] } {
  const records: RawArchiveRecord[] = [];
  let skipped = 0;
  const lineNumbers: number[] = [];
  const lines = text.split("\n");
  lines.forEach((line, position) => {
    const value = line.trim();
    if (!value) return;
    let record: unknown;
    try {
      record = JSON.parse(value);
    } catch {
      skipped += 1;
      lineNumbers.push(position + 1);
      return;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      skipped += 1;
      lineNumbers.push(position + 1);
      return;
    }
    const item = record as Record<string, unknown>;
    const url = typeof item.url === "string" ? item.url : "";
    if (!url) {
      skipped += 1;
      lineNumbers.push(position + 1);
      return;
    }
    const rawTimestamp = typeof item.timestamp === "string" ? item.timestamp : "";
    records.push({
      url,
      statusCode: String(item.status ?? "0") || "0",
      length: String(item.length ?? "0") || "0",
      fileType: (String(item.mime ?? "unknown") || "unknown").split(";")[0].trim(),
      timestamp: formatTimestamp(rawTimestamp),
      rawTimestamp,
      source: "commoncrawl",
      indexId,
    });
  });
  const reasons: ReasonDto[] = [];
  if (skipped > 0) {
    reasons.push({
      code: "parse_line",
      message: `${skipped} 行响应无法解析，已跳过；结果可能不完整`,
      source: "commoncrawl",
      indexId,
      page,
      count: skipped,
      context: { lineNumbers: lineNumbers.slice(0, 5) },
    });
  }
  return { records, reasons };
}

export class CommonCrawlAdapter implements CommonCrawlPort {
  private readonly indexBaseUrl: string;
  private readonly allowInsecureCdxApi: boolean;

  constructor(options: CommonCrawlAdapterOptions = {}) {
    this.indexBaseUrl = (options.indexBaseUrl ?? DEFAULT_CC_BASE).replace(/\/+$/, "");
    this.allowInsecureCdxApi = options.allowInsecureCdxApi === true;
  }

  /** Only official Common Crawl or the configured index origin may serve requests. */
  private isAllowedEndpoint(raw: string): boolean {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (url.username || url.password) return false;
    if (url.protocol === "https:" && url.hostname === "index.commoncrawl.org") return true;
    try {
      const base = new URL(this.indexBaseUrl);
      if (url.origin === base.origin) {
        return url.protocol === "https:" || this.allowInsecureCdxApi;
      }
    } catch {
      return false;
    }
    return false;
  }

  /** cdx-api values must be allowed endpoints and carry no userinfo/query/hash. */
  private isValidCdxApi(raw: string): boolean {
    if (!this.isAllowedEndpoint(raw)) return false;
    try {
      const url = new URL(raw);
      return !url.search && !url.hash;
    } catch {
      return false;
    }
  }

  private withRedirectGuard(options: RequestOptions): RequestOptions {
    return { ...options, validateRedirect: (target) => this.isAllowedEndpoint(target) };
  }

  async fetchIndexes(
    options: RequestOptions,
  ): Promise<{ metas: CcIndexMeta[]; invalidCount: number }> {
    const url = `${this.indexBaseUrl}/collinfo.json`;
    const response = await fetchText(options.transport, url, this.withRedirectGuard(options));
    let data: unknown;
    try {
      data = JSON.parse(response.text);
    } catch {
      throw new AppError("PARSE", "collinfo.json 不是有效 JSON，无法确定索引范围", {
        source: "commoncrawl",
      });
    }
    if (!Array.isArray(data)) {
      throw new AppError("PARSE", "collinfo.json 不是索引数组，无法确定索引范围", {
        source: "commoncrawl",
      });
    }
    const metas: CcIndexMeta[] = [];
    let invalidCount = 0;
    for (const item of data) {
      const meta = parseCcIndex(item);
      if (!meta || !this.isValidCdxApi(meta.cdxApi)) {
        invalidCount += 1;
        continue;
      }
      metas.push(meta);
    }
    return { metas, invalidCount };
  }

  async pageCount(index: CcIndexMeta, host: string, options: RequestOptions): Promise<number> {
    const url = withParams(index.cdxApi, {
      url: `*.${host}`,
      output: "json",
      pageSize: "5",
      showNumPages: "true",
    });
    const response = await fetchText(options.transport, url, this.withRedirectGuard(options));
    let data: unknown;
    try {
      data = JSON.parse(response.text);
    } catch {
      throw new Error(`索引 ${index.id} 页数响应不是有效 JSON`);
    }
    if (typeof data !== "object" || data === null) throw new Error(`索引 ${index.id} 页数响应格式无效`);
    const pages = Number((data as Record<string, unknown>).pages ?? 0);
    return Number.isFinite(pages) ? Math.max(0, Math.trunc(pages)) : 0;
  }

  async queryPage(
    index: CcIndexMeta,
    host: string,
    page: number,
    pageSize: number,
    options: RequestOptions,
  ): Promise<PageResult> {
    const url = withParams(index.cdxApi, {
      url: `*.${host}`,
      output: "json",
      page: String(page),
      pageSize: String(pageSize),
    });
    const response = await fetchText(options.transport, url, this.withRedirectGuard(options));
    const parsed = parseNdjson(response.text, index.id, page);
    return {
      records: parsed.records,
      hasMore: parsed.records.length > 0,
      parseSkipped: parsed.reasons.reduce((sum, reason) => sum + (reason.count ?? 0), 0),
      reasons: parsed.reasons,
    };
  }
}
