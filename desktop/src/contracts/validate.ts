/** Runtime validation for untrusted IPC payloads (TypeScript types are not a guard). */

import {
  EMPTY_FILTER,
  SOURCES,
  type CancelQueryRequest,
  type CopyRequest,
  type ExportRequest,
  type FilterSpec,
  type GetViewRequest,
  type ProxySpec,
  type RangeSpec,
  type Result,
  type SortKey,
  type SortSpec,
  type SourceId,
  type StartQueryRequest,
} from "./types";

const SORT_KEYS: ReadonlyArray<SortKey> = [
  "timestamp",
  "status_code",
  "length",
  "file_type",
  "url",
];

function fail(message: string): { ok: false; error: { code: "INVALID_INPUT"; message: string } } {
  return { ok: false, error: { code: "INVALID_INPUT", message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSourceId(value: unknown): value is SourceId {
  return typeof value === "string" && (SOURCES as ReadonlyArray<string>).includes(value);
}

export function validateRange(raw: unknown): Result<RangeSpec> {
  if (!isRecord(raw)) return fail("range 必须是对象");
  const kind = raw.kind;
  if (kind === "all") return { ok: true, value: { kind: "all" } };
  if (kind === "recent") {
    const months = raw.months;
    if (typeof months !== "number" || !Number.isInteger(months) || months < 1 || months > 120) {
      return fail("months 必须是 1..120 的整数");
    }
    return { ok: true, value: { kind: "recent", months } };
  }
  if (kind === "month") {
    const year = raw.year;
    const month = raw.month;
    if (typeof year !== "number" || !Number.isInteger(year) || year < 2000 || year > 2100) {
      return fail("year 必须是 2000..2100 的整数");
    }
    if (typeof month !== "number" || !Number.isInteger(month) || month < 1 || month > 12) {
      return fail("month 必须是 1..12 的整数");
    }
    return { ok: true, value: { kind: "month", year, month } };
  }
  return fail("range.kind 必须是 recent/month/all");
}

export function validateProxy(raw: unknown): Result<ProxySpec> {
  if (!isRecord(raw)) return fail("proxy 必须是对象");
  const mode = raw.mode;
  if (mode === "direct" || mode === "system") return { ok: true, value: { mode } };
  if (mode === "fixed") {
    const server = raw.server;
    if (typeof server !== "string" || !server.trim()) {
      return fail("固定代理必须提供 server");
    }
    const value = server.trim();
    if (!/^(https?|socks5):\/\/[^\s/]+$/i.test(value)) {
      return fail("代理地址格式应为 http(s)://host:port 或 socks5://host:port");
    }
    return { ok: true, value: { mode, server: value } };
  }
  return fail("proxy.mode 必须是 direct/system/fixed");
}

export function validateStart(raw: unknown): Result<StartQueryRequest> {
  if (!isRecord(raw)) return fail("startQuery 参数必须是对象");
  if (typeof raw.target !== "string") return fail("target 必须是字符串");
  if (!isSourceId(raw.source)) return fail("source 必须是 wayback 或 commoncrawl");
  const range = validateRange(raw.range);
  if (!range.ok) return range;
  const proxy = validateProxy(raw.proxy);
  if (!proxy.ok) return proxy;
  return {
    ok: true,
    value: { target: raw.target, source: raw.source, range: range.value, proxy: proxy.value },
  };
}

export function validateJobRef(raw: unknown): Result<{ jobId: number; source: SourceId }> {
  if (!isRecord(raw)) return fail("参数必须是对象");
  if (typeof raw.jobId !== "number" || !Number.isInteger(raw.jobId) || raw.jobId <= 0) {
    return fail("jobId 必须是正整数");
  }
  if (!isSourceId(raw.source)) return fail("source 必须是 wayback 或 commoncrawl");
  return { ok: true, value: { jobId: raw.jobId, source: raw.source } };
}

export function validateFilter(raw: unknown): Result<FilterSpec> {
  if (raw === undefined) return { ok: true, value: { ...EMPTY_FILTER } };
  if (!isRecord(raw)) return fail("filter 必须是对象");
  const status = typeof raw.status === "string" ? raw.status : "";
  const fileType = typeof raw.fileType === "string" ? raw.fileType : "";
  const urlKeyword = typeof raw.urlKeyword === "string" ? raw.urlKeyword : "";
  const domain = typeof raw.domain === "string" ? raw.domain : "";
  const interestingOnly = raw.interestingOnly === true;
  return { ok: true, value: { status, fileType, urlKeyword, domain, interestingOnly } };
}

export function validateSort(raw: unknown): Result<SortSpec> {
  if (raw === undefined) return { ok: true, value: { key: null, reverse: false } };
  if (!isRecord(raw)) return fail("sort 必须是对象");
  const key = raw.key;
  if (key !== null && (typeof key !== "string" || !SORT_KEYS.includes(key as SortKey))) {
    return fail("sort.key 不在允许的列内");
  }
  return { ok: true, value: { key: key as SortKey | null, reverse: raw.reverse === true } };
}

export function validateGetView(raw: unknown): Result<GetViewRequest> {
  const ref = validateJobRef(raw);
  if (!ref.ok) return ref;
  const input = raw as Record<string, unknown>;
  const filter = validateFilter(input.filter);
  if (!filter.ok) return filter;
  const sort = validateSort(input.sort);
  if (!sort.ok) return sort;
  const pageIndex = input.pageIndex;
  const pageSize = input.pageSize;
  if (typeof pageIndex !== "number" || !Number.isInteger(pageIndex) || pageIndex < 0) {
    return fail("pageIndex 必须是 >=0 的整数");
  }
  if (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 5000) {
    return fail("pageSize 必须是 1..5000 的整数");
  }
  return {
    ok: true,
    value: {
      jobId: ref.value.jobId,
      source: ref.value.source,
      filter: filter.value,
      sort: sort.value,
      pageIndex,
      pageSize,
    },
  };
}

export function validateExport(raw: unknown): Result<ExportRequest> {
  const ref = validateJobRef(raw);
  if (!ref.ok) return ref;
  const input = raw as Record<string, unknown>;
  const filter = validateFilter(input.filter);
  if (!filter.ok) return filter;
  const sort = validateSort(input.sort);
  if (!sort.ok) return sort;
  if (
    typeof input.expectedRevision !== "number" ||
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    return fail("expectedRevision 必须是 >=0 的整数");
  }
  if (input.format !== "csv" && input.format !== "json") {
    return fail("format 必须是 csv 或 json");
  }
  return {
    ok: true,
    value: {
      jobId: ref.value.jobId,
      source: ref.value.source,
      expectedRevision: input.expectedRevision,
      filter: filter.value,
      sort: sort.value,
      format: input.format,
    },
  };
}

export function validateCancel(raw: unknown): Result<CancelQueryRequest> {
  return validateJobRef(raw);
}

export function validateCopy(raw: unknown): Result<CopyRequest> {
  const ref = validateJobRef(raw);
  if (!ref.ok) return ref;
  const input = raw as Record<string, unknown>;
  if (
    typeof input.revision !== "number" ||
    !Number.isInteger(input.revision) ||
    input.revision < 0
  ) {
    return fail("revision 必须是 >=0 的整数");
  }
  if (!Array.isArray(input.rowIds) || input.rowIds.length > 10000) {
    return fail("rowIds 必须是最多 10000 项的数组");
  }
  if (!input.rowIds.every((item) => typeof item === "string")) {
    return fail("rowIds 只能包含字符串");
  }
  if (input.mode !== "url" && input.mode !== "row") {
    return fail("mode 必须是 url 或 row");
  }
  return {
    ok: true,
    value: {
      jobId: ref.value.jobId,
      source: ref.value.source,
      revision: input.revision,
      rowIds: input.rowIds as string[],
      mode: input.mode,
    },
  };
}
