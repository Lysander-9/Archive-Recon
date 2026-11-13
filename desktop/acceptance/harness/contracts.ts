/**
 * Portable acceptance contracts for the TypeScript/Electron rewrite.
 *
 * These types mirror ADR-002 section 5. They are acceptance-local on purpose:
 * this directory must not modify the shared `src/contracts`. Once the contract
 * commit lands, `harness/iut.ts` can be pointed at the production modules and
 * the same assertions must run unchanged.
 */

export type Source = "wayback" | "commoncrawl";
export type ExportFormat = "csv" | "json";

export type JobStatus =
  | "preparing"
  | "running"
  | "stopping"
  | "completed"
  | "partial"
  | "failed"
  | "stopped";

export type ErrorCode =
  | "INVALID_INPUT"
  | "BUSY"
  | "STALE_VIEW"
  | "NETWORK"
  | "TIMEOUT"
  | "PARSE"
  | "EXPORT"
  | "CLOSED"
  | "NOT_FOUND";

export interface AppError {
  code: ErrorCode;
  message: string;
  source?: Source;
  context?: Record<string, unknown>;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError };

export interface FrozenScope {
  /** Normalized input form, e.g. example.com or *.example.com. */
  input: string;
  /** Lower-case host without the wildcard prefix. */
  host: string;
  wildcard: boolean;
  /** Frozen matching mode: target host and all of its subdomains. */
  match: "domain";
}

export type TimeRange =
  | { kind: "months"; months: number }
  | { kind: "month"; year: number; month: number }
  | { kind: "all" };

export interface ProxyConfig {
  mode: "direct" | "system" | "fixed";
  /** fixed mode only; http, https or socks5 URL. */
  url?: string;
  /** system mode only; environment variable that supplied the proposal. */
  sourceEnv?: string;
}

export interface FrozenJobConfig {
  target: FrozenScope;
  source: Source;
  range: TimeRange;
  /** Frozen UTC clock instant (ISO-8601, Z). */
  clockUtc: string;
  proxy: ProxyConfig;
  budgets: { waybackPages: 20; waybackPageSize: 50; ccPagesPerIndex: 5; ccPageSize: 5 };
}

export interface ArchiveRecord {
  /** Display/export order: timestamp, status_code, length, file_type, url. */
  url: string;
  statusCode: string;
  length: string;
  fileType: string;
  timestamp: string;
  source: Source;
  rawTimestamp: string;
  indexId: string;
  rowId: string;
}

export interface ExportRow {
  timestamp: string;
  status_code: string;
  length: string;
  file_type: string;
  url: string;
}

export interface FilterSpec {
  status?: string;
  fileType?: string;
  urlKeyword?: string;
  domain?: string;
  interestingOnly?: boolean;
}

export interface SortSpec {
  column?: "timestamp" | "status_code" | "length" | "file_type" | "url" | "";
  reverse?: boolean;
}

export interface JobView {
  jobId: number;
  source: Source;
  revision: number;
  rows: ArchiveRecord[];
  received: number;
  unique: number;
  matched: number;
  pageCount: number;
  pageIndex: number;
  pageSize: number;
  scope: FrozenScope;
  status: JobStatus;
  reasons: string[];
  range: TimeRange;
}

export interface JobEvent {
  schemaVersion: 1;
  jobId: number;
  source: Source;
  seq: number;
  revision: number;
  kind: "state" | "progress" | "viewChanged" | "reason";
  payload: Record<string, unknown>;
}

export interface StartQueryRequest {
  target: string;
  source: Source;
  range: TimeRange;
  proxy?: ProxyConfig;
}

export interface StartQueryResult {
  jobId: number;
  source: Source;
  frozenScope: FrozenScope;
}

export interface CancelResult {
  jobId: number;
  status: JobStatus;
}

export interface ExportRequest {
  jobId: number;
  source: Source;
  expectedRevision: number;
  filter?: FilterSpec;
  sort?: SortSpec;
  format: ExportFormat;
}

export interface ExportResult {
  cancelled: boolean;
  saved: boolean;
  count: number;
  path?: string;
}
