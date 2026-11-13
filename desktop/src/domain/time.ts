/**
 * UTC calendar-month windows and Common Crawl official interval selection.
 * Never derives a month from an index id or name.
 */

import type { RangeSpec, TimeRangeSelection, TimeWindow } from "../contracts/types";

export interface IntervalMs {
  fromMs: number;
  toMs: number;
}

export function utcMonthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
}

export function utcMonthWindow(year: number, month: number): TimeWindow & IntervalMs {
  const start = utcMonthStart(year, month);
  const end = month === 12 ? utcMonthStart(year + 1, 1) : utcMonthStart(year, month + 1);
  return {
    fromUtc: start.toISOString(),
    toUtc: end.toISOString(),
    label: `${year}-${String(month).padStart(2, "0")}（UTC 自然月）`,
    fromMs: start.getTime(),
    toMs: end.getTime(),
  };
}

export function resolveRange(range: RangeSpec, clock: Date): TimeRangeSelection {
  if (range.kind === "all") {
    return {
      range,
      window: null,
      unknown: false,
      note: "全部已发布索引；每条记录的时间范围以来源值为准。",
    };
  }
  if (range.kind === "month") {
    const window = utcMonthWindow(range.year, range.month);
    return {
      range,
      window: { fromUtc: window.fromUtc, toUtc: window.toUtc, label: window.label },
      unknown: false,
      note: "按索引官方 from/to 区间与自然月窗口相交选择。",
    };
  }
  const months = Math.max(1, Math.min(120, Math.trunc(range.months)));
  const endYear = clock.getUTCFullYear();
  const endMonth = clock.getUTCMonth() + 1;
  const startTotal = endYear * 12 + (endMonth - 1) - (months - 1);
  const startYear = Math.floor(startTotal / 12);
  const startMonth = (startTotal % 12) + 1;
  const startWindow = utcMonthWindow(startYear, startMonth);
  const endWindow = utcMonthWindow(endYear, endMonth);
  return {
    range: { kind: "recent", months },
    window: {
      fromUtc: startWindow.fromUtc,
      toUtc: endWindow.toUtc,
      label: `最近 ${months} 个自然月（含当月，UTC）`,
    },
    unknown: false,
    note: "含当月的自然月窗口；只选索引，不代表每条记录都落在窗口内。",
  };
}

export function parseOfficialTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  const compact = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  const match = compact ?? iso;
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? "0");
  const minute = Number(match[5] ?? "0");
  const second = Number(match[6] ?? "0");
  const millisecond = Number((match[7] ?? "0").padEnd(3, "0"));
  const timezone = match[8] ?? "";

  if (month < 1 || month > 12) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (timezone && timezone !== "Z") {
    const sign = timezone.startsWith("-") ? -1 : 1;
    const digits = timezone.slice(1).replace(":", "");
    const offsetHour = Number(digits.slice(0, 2));
    const offsetMinute = Number(digits.slice(2, 4));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }

  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const check = new Date(wallMs);
  // Reject rollover such as 2024-02-30 or 25:00 instead of silently normalising.
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second ||
    check.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }
  return wallMs - offsetMinutes * 60_000;
}

export interface CcIndexMeta {
  id: string;
  cdxApi: string;
  fromMs: number | null;
  toMs: number | null;
  /** True when official from/to is missing, invalid or inverted. */
  unknown: boolean;
  fromRaw: string | null;
  toRaw: string | null;
}

export function parseCcIndex(raw: unknown): CcIndexMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const cdxApi = typeof record["cdx-api"] === "string" ? (record["cdx-api"] as string) : "";
  if (!id || !cdxApi) return null;
  const fromRaw = typeof record.from === "string" ? record.from : null;
  const toRaw = typeof record.to === "string" ? record.to : null;
  const fromMs = parseOfficialTimestamp(fromRaw);
  const toMs = parseOfficialTimestamp(toRaw);
  const unknown = fromMs === null || toMs === null || fromMs > toMs;
  return { id, cdxApi, fromMs, toMs, unknown, fromRaw, toRaw };
}

export interface IndexSelection {
  indexes: CcIndexMeta[];
  unknownExcluded: number;
  /** True when some selected indexes still have unknown official metadata. */
  unknownIncluded: boolean;
}

export function selectIndexes(metas: CcIndexMeta[], selection: TimeRangeSelection): IndexSelection {
  const window = selection.window;
  if (!window) {
    return {
      indexes: metas,
      unknownExcluded: 0,
      unknownIncluded: metas.some((meta) => meta.unknown),
    };
  }
  const startMs = Date.parse(window.fromUtc);
  const endMs = Date.parse(window.toUtc);
  const indexes: CcIndexMeta[] = [];
  let unknownExcluded = 0;
  for (const meta of metas) {
    if (meta.unknown) {
      unknownExcluded += 1;
      continue;
    }
    const fromMs = meta.fromMs as number;
    const toMs = meta.toMs as number;
    if (fromMs < endMs && toMs >= startMs) indexes.push(meta);
  }
  return { indexes, unknownExcluded, unknownIncluded: false };
}

export function describeSelection(selection: TimeRangeSelection): string {
  if (!selection.window) return "全部时间";
  return selection.window.label;
}
