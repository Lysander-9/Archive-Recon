/** Wayback CDX adapter. Uses the official endpoint shape of the Python baseline. */

import type { PageResult, WaybackPort, RequestOptions } from "../../application/ports";
import type { ReasonDto } from "../../contracts/types";
import { formatTimestamp, type RawArchiveRecord } from "../../domain/record";
import { fetchText } from "./http";

export const DEFAULT_WAYBACK_URL = "https://web.archive.org/cdx/search/cdx";

interface WaybackAdapterOptions {
  baseUrl?: string;
}

function parseRows(text: string): {
  records: RawArchiveRecord[];
  reasons: ReasonDto[];
  rowCount: number;
} {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      records: [],
      reasons: [
        {
          code: "parse_record",
          message: "Wayback 响应不是有效 JSON，已忽略本次内容",
          source: "wayback",
          count: 1,
        },
      ],
      rowCount: 0,
    };
  }
  if (!Array.isArray(data)) {
    return {
      records: [],
      reasons: [
        {
          code: "parse_record",
          message: "Wayback 响应不是记录数组，已忽略本次内容",
          source: "wayback",
          count: 1,
        },
      ],
      rowCount: 0,
    };
  }
  if (data.length < 2) return { records: [], reasons: [], rowCount: 0 };
  const headers = data[0];
  if (!Array.isArray(headers)) {
    return {
      records: [],
      reasons: [
        {
          code: "parse_record",
          message: "Wayback 响应缺少列头数组，已忽略本次内容",
          source: "wayback",
          count: 1,
        },
      ],
      rowCount: 0,
    };
  }

  const records: RawArchiveRecord[] = [];
  let skipped = 0;
  const lineNumbers: number[] = [];
  for (let index = 1; index < data.length; index += 1) {
    const row = data[index];
    if (!Array.isArray(row) || row.length !== headers.length) {
      skipped += 1;
      lineNumbers.push(index + 1);
      continue;
    }
    const item = Object.fromEntries(headers.map((key, position) => [String(key), row[position]])) as Record<
      string,
      unknown
    >;
    const rawTimestamp = typeof item.timestamp === "string" ? item.timestamp : "";
    const url = typeof item.original === "string" ? item.original : "";
    if (!url) {
      skipped += 1;
      lineNumbers.push(index + 1);
      continue;
    }
    records.push({
      url,
      statusCode: String(item.statuscode ?? "0") || "0",
      length: String(item.length ?? "0") || "0",
      fileType: (String(item.mimetype ?? "unknown") || "unknown").split(";")[0].trim(),
      timestamp: formatTimestamp(rawTimestamp),
      rawTimestamp,
      source: "wayback",
    });
  }
  const reasons: ReasonDto[] = [];
  if (skipped > 0) {
    reasons.push({
      code: "parse_line",
      message: `${skipped} 行响应无法解析，已跳过；结果可能不完整`,
      source: "wayback",
      count: skipped,
      context: { lineNumbers: lineNumbers.slice(0, 5) },
    });
  }
  return { records, reasons, rowCount: data.length - 1 };
}

export class WaybackAdapter implements WaybackPort {
  private readonly baseUrl: string;

  constructor(options: WaybackAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_WAYBACK_URL;
  }

  async queryPage(
    host: string,
    page: number,
    pageSize: number,
    options: RequestOptions,
  ): Promise<PageResult> {
    const params: Record<string, string> = {
      url: host,
      matchType: "domain",
      output: "json",
      fl: "urlkey,timestamp,original,mimetype,statuscode,digest,length",
      collapse: "urlkey",
      limit: String(pageSize),
    };
    if (page > 0) params.page = String(page);
    const url = new URL(this.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetchText(options.transport, url.toString(), options);
    const parsed = parseRows(response.text);
    return {
      records: parsed.records,
      hasMore: parsed.records.length >= pageSize,
      parseSkipped: parsed.reasons.reduce((sum, reason) => sum + (reason.count ?? 0), 0),
      reasons: parsed.reasons,
    };
  }
}
