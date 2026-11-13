/** Version 1 shared contracts for the desktop app. No Electron/DOM imports. */

export const SCHEMA_VERSION = 1 as const;
export const EXPORT_FIELDS = ["timestamp", "status_code", "length", "file_type", "url"] as const;
export type ExportField = (typeof EXPORT_FIELDS)[number];

export const SOURCES = ["wayback", "commoncrawl"] as const;
export type SourceId = (typeof SOURCES)[number];

export const WAYBACK_BUDGET = { maxPages: 20, pageSize: 50 } as const;
export const CC_BUDGET = { maxPagesPerIndex: 5, pageSize: 5 } as const;

export type JobStatus =
  | "preparing"
  | "running"
  | "stopping"
  | "completed"
  | "partial"
  | "failed"
  | "stopped";

export const TERMINAL_STATUSES: ReadonlyArray<JobStatus> = [
  "completed",
  "partial",
  "failed",
  "stopped",
];

export type ErrorCode =
  | "INVALID_INPUT"
  | "BUSY"
  | "STALE_VIEW"
  | "NETWORK"
  | "TIMEOUT"
  | "PARSE"
  | "EXPORT"
  | "CLOSED"
  | "PROXY"
  | "INTERNAL";

export interface AppErrorDto {
  code: ErrorCode;
  message: string;
  source?: SourceId;
  retryable?: boolean;
  context?: Record<string, unknown>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppErrorDto };

export interface TargetScope {
  /** Normalized host without the wildcard alias, e.g. "example.com". */
  host: string;
  /** True when the user typed the "*.example.com" alias. */
  wildcard: boolean;
  /** Fixed query semantics: the target host and its subdomains. */
  match: "host-and-subdomains";
  label: string;
}

export type RangeSpec =
  | { kind: "recent"; months: number }
  | { kind: "month"; year: number; month: number }
  | { kind: "all" };

/** Inclusive start, exclusive end, both ISO-8601 UTC strings. */
export interface TimeWindow {
  fromUtc: string;
  toUtc: string;
  label: string;
}

export interface TimeRangeSelection {
  range: RangeSpec;
  /** Null means "all time" or "unknown" for limited ranges. */
  window: TimeWindow | null;
  unknown: boolean;
  note: string;
}

export type ProxyMode = "direct" | "system" | "fixed";

export interface ProxySpec {
  mode: ProxyMode;
  /** Required for fixed mode, e.g. "http://127.0.0.1:7890". */
  server?: string;
}

export interface ProxySnapshot {
  mode: ProxyMode;
  /** Redacted for display: credentials never leave main. */
  display: string;
  server?: string;
}

export interface FrozenJobConfig {
  target: TargetScope;
  source: SourceId;
  range: RangeSpec;
  clockUtc: string;
  selection: TimeRangeSelection;
  proxy: ProxySnapshot;
  budget: { maxPages: number; pageSize: number };
}

export interface FilterSpec {
  status: string;
  fileType: string;
  urlKeyword: string;
  domain: string;
  interestingOnly: boolean;
}

export const EMPTY_FILTER: FilterSpec = {
  status: "",
  fileType: "",
  urlKeyword: "",
  domain: "",
  interestingOnly: false,
};

export type SortKey = ExportField;

export interface SortSpec {
  key: SortKey | null;
  reverse: boolean;
}

export interface RowView {
  rowId: string;
  timestamp: string;
  statusCode: string;
  length: string;
  fileType: string;
  url: string;
  /** True when the row matches the shared "interesting path" rules (P1 highlight). */
  interesting: boolean;
}

export interface ReasonDto {
  code:
    | "parse_line"
    | "parse_record"
    | "network"
    | "page_limit"
    | "record_limit"
    | "stopped"
    | "range_unknown"
    | "unknown";
  message: string;
  source?: SourceId;
  indexId?: string;
  page?: number;
  count?: number;
  retryable?: boolean;
  context?: Record<string, unknown>;
}

export interface JobScopeView {
  host: string;
  label: string;
  match: "host-and-subdomains";
  rangeLabel: string;
  clockUtc: string;
  proxyDisplay: string;
  budgetLabel: string;
}

export interface JobView {
  schemaVersion: typeof SCHEMA_VERSION;
  jobId: number;
  source: SourceId;
  revision: number;
  status: JobStatus;
  rows: RowView[];
  received: number;
  unique: number;
  matched: number;
  total: number;
  pageIndex: number;
  pageSize: number;
  pageCount: number;
  scope: JobScopeView;
  reasons: ReasonDto[];
  completion: "complete" | "partial" | "unknown";
  terminal: boolean;
}

export interface StartQueryRequest {
  target: string;
  source: SourceId;
  range: RangeSpec;
  proxy: ProxySpec;
}

export interface CancelQueryRequest {
  jobId: number;
  source: SourceId;
}

export interface GetViewRequest {
  jobId: number;
  source: SourceId;
  filter: FilterSpec;
  sort: SortSpec;
  pageIndex: number;
  pageSize: number;
}

export interface ExportRequest {
  jobId: number;
  source: SourceId;
  expectedRevision: number;
  filter: FilterSpec;
  sort: SortSpec;
  format: "csv" | "json";
}

export interface ExportOutcome {
  saved: boolean;
  count: number;
  filePath?: string;
}

export interface CopyRequest {
  jobId: number;
  source: SourceId;
  revision: number;
  rowIds: string[];
  mode: "url" | "row";
}

export interface CopyOutcome {
  copiedCount: number;
}

/** Restricted clipboard bridge for the current job's incomplete reasons. */
export interface CopyReasonsRequest {
  jobId: number;
  source: SourceId;
  revision: number;
}

export interface CopyReasonsOutcome {
  /** Number of reasons written; 0 means there was nothing to copy. */
  copiedCount: number;
  reasonCount: number;
}

export interface JobEventDto {
  schemaVersion: typeof SCHEMA_VERSION;
  jobId: number;
  source: SourceId;
  seq: number;
  revision: number;
  kind: "state" | "progress" | "viewChanged" | "reason";
  payload: Record<string, unknown>;
}
