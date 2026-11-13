/**
 * Acceptance-local implementation of the ADR-002 behaviour.
 *
 * This is NOT product code. It exists so the independent acceptance suite is
 * runnable before the production contract commit: every assertion here is
 * written against the documented contract and can later be pointed at the
 * real modules through `harness/iut.ts`.
 *
 * `mode: "legacy"` deliberately reproduces the known Python 6349a0e defects
 * (R1-R5, userinfo/whitespace validation, proxy direct fallback) so the suite
 * has sensitivity evidence. `mode: "reference"` is the conforming oracle.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AppError, ArchiveRecord, CancelResult, ExportFormat, ExportRequest,
  ExportResult, FilterSpec, FrozenJobConfig, FrozenScope, JobEvent, JobStatus,
  JobView, ProxyConfig, Result, SortSpec, Source, StartQueryRequest,
  StartQueryResult, TimeRange,
} from "./contracts.ts";
import { FixedClock, monthWindowUtc, rangeWindows } from "./clock.ts";

export interface TransportRequest {
  source: Source;
  kind: "wayback-page" | "cc-collinfo" | "cc-page-count" | "cc-page";
  url: string;
  jobId: number;
  proxy: ProxyConfig;
  page?: number;
  indexId?: string;
}

export interface TransportResponse {
  status: number;
  text: string;
}

export interface TransportCall {
  source: Source;
  kind: string;
  url: string;
  jobId: number;
  proxy: ProxyConfig;
}

export interface Transport {
  fetchText(request: TransportRequest): Promise<TransportResponse>;
  calls: TransportCall[];
}

export class ProxyFailure extends Error {
  readonly code = "PROXY_CONNECT_REFUSED";
  constructor(message: string) {
    super(message);
  }
}

export interface CollInfoEntry {
  id: string;
  name?: string;
  cdxApi?: string;
  from?: string | null;
  to?: string | null;
}

export interface IutOptions {
  transport: Transport;
  clockUtc: string;
  mode?: "reference" | "legacy";
  defaultExportPath?: string;
  /** Return true to simulate the user cancelling the save dialog. */
  cancelExport?: () => boolean;
}

export interface Iut {
  startQuery(request: StartQueryRequest): Result<StartQueryResult>;
  cancelQuery(jobId: number, source: Source): Result<CancelResult>;
  getView(jobId: number, source: Source, filter?: FilterSpec, sort?: SortSpec, pageIndex?: number, pageSize?: number): Result<JobView>;
  exportResults(request: ExportRequest & { path?: string }): Result<ExportResult>;
  scrollCc(jobId?: number): Result<{ accepted: boolean }>;
  setTargetInput(value: string): void;
  subscribe(listener: (event: JobEvent) => void): () => void;
  close(): void;
  flushEvents(): Promise<JobEvent[]>;
  eventsFor(jobId: number): JobEvent[];
  getStatus(jobId: number): JobStatus | undefined;
  getFrozenConfig(jobId: number): FrozenJobConfig | undefined;
}

export interface RecordingSink {
  events: JobEvent[];
  closedAt?: number;
  deliver(event: JobEvent): void;
}

const BUDGETS = {
  waybackPages: 20,
  waybackPageSize: 50,
  ccPagesPerIndex: 5,
  ccPageSize: 5,
} as const;

const SOURCES = new Set<Source>(["wayback", "commoncrawl"]);

// ==================== target validation ====================

export function normalizeTarget(input: string): Result<FrozenScope> {
  const value = (input ?? "").trim();
  if (!value) {
    return fail("INVALID_INPUT", "请输入目标域名后再开始查询。");
  }
  if (value.includes("@") || value.includes("\\") || value.includes("%")) {
    return fail("INVALID_INPUT", "域名中不允许用户信息、反斜杠或百分号编码。");
  }
  if (/\s/.test(value)) {
    return fail("INVALID_INPUT", "域名中不允许空白字符。");
  }

  let rest = value;
  if (rest.includes("://")) {
    const match = /^(https?):\/\/(.*)$/i.exec(rest);
    if (!match) {
      return fail("INVALID_INPUT", "域名格式无效，请输入 example.com 或 *.example.com。");
    }
    rest = match[2];
  }
  if (rest.endsWith("/")) {
    rest = rest.slice(0, -1);
  }
  if (rest.includes("/") || rest.includes("?") || rest.includes("#") || rest.includes(":")) {
    return fail("INVALID_INPUT", "这里只接受域名，不接受路径、端口、查询参数或片段。");
  }
  if (rest.endsWith(".")) {
    return fail("INVALID_INPUT", "域名格式无效，请检查各级域名标签。");
  }

  let wildcard = false;
  if (rest.startsWith("*.")) {
    wildcard = true;
    rest = rest.slice(2);
  } else if (rest.includes("*")) {
    return fail("INVALID_INPUT", "通配符只允许出现在最左侧的 *. 前缀。");
  }
  const host = rest.toLowerCase();
  if (!host) {
    return fail("INVALID_INPUT", "域名格式无效，请输入 example.com 或 *.example.com。");
  }
  const labels = host.split(".");
  if (labels.length < 2) {
    // Localhost/single-label inputs are not a target domain for this product.
    return fail("INVALID_INPUT", "域名格式无效，请输入完整域名，例如 example.com。");
  }
  for (const label of labels) {
    if (!label || label.length > 63 || label.startsWith("-") || label.endsWith("-")) {
      return fail("INVALID_INPUT", "域名格式无效，请检查各级域名标签。");
    }
    if (!/^[a-z0-9-]+$/.test(label)) {
      return fail("INVALID_INPUT", "域名格式无效，请检查各级域名标签。");
    }
  }
  return ok({
    input: wildcard ? `*.${host}` : host,
    host,
    wildcard,
    match: "domain",
  });
}

// ==================== time metadata ====================

type MetadataState =
  | { kind: "ok"; from: Date; to: Date }
  | { kind: "unknown"; reason: string };

export function classifyMetadata(entry: CollInfoEntry): MetadataState {
  if (!entry.from || !entry.to) {
    return { kind: "unknown", reason: `${entry.id}: 时间范围缺失` };
  }
  const from = parseArchiveInstant(entry.from);
  const to = parseArchiveInstant(entry.to);
  if (!from || !to) {
    return { kind: "unknown", reason: `${entry.id}: 时间范围非法` };
  }
  if (from.getTime() > to.getTime()) {
    return { kind: "unknown", reason: `${entry.id}: 时间范围倒置` };
  }
  return { kind: "ok", from, to };
}

function parseArchiveInstant(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(trimmed) ? trimmed : `${trimmed}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : new Date(ms);
}

export interface SelectedIndex {
  entry: CollInfoEntry;
  matchedWindows: string[];
}

export interface SelectionResult {
  selected: SelectedIndex[];
  unknown: { entry: CollInfoEntry; reason: string }[];
}

export function selectIndexes(entries: CollInfoEntry[], range: TimeRange, clockUtc: string): SelectionResult {
  if (range.kind === "all") {
    const selected: SelectedIndex[] = [];
    const unknown: { entry: CollInfoEntry; reason: string }[] = [];
    for (const entry of entries) {
      const state = classifyMetadata(entry);
      if (state.kind === "ok") {
        selected.push({ entry, matchedWindows: ["all"] });
      } else {
        selected.push({ entry, matchedWindows: [] });
        unknown.push({ entry, reason: state.reason });
      }
    }
    return { selected, unknown };
  }

  const windows = rangeWindows(range, clockUtc);
  const selected: SelectedIndex[] = [];
  const unknown: { entry: CollInfoEntry; reason: string }[] = [];
  for (const entry of entries) {
    const state = classifyMetadata(entry);
    if (state.kind === "unknown") {
      unknown.push({ entry, reason: state.reason });
      continue;
    }
    const matched = windows.filter((window) => (
      state.from.getTime() < Date.parse(window.end) &&
      state.to.getTime() >= Date.parse(window.start)
    ));
    if (matched.length) {
      selected.push({ entry, matchedWindows: matched.map((w) => `${w.year}-${String(w.month).padStart(2, "0")}`) });
    }
  }
  return { selected, unknown };
}

// ==================== filters / sort ====================

const INTERESTING_PATTERNS = [
  /\.bak$/i, /\.backup$/i, /\.old$/i, /\.swp$/i, /\.save$/i,
  /\.sql$/i, /\.sql\.gz$/i, /\.db$/i, /\.sqlite$/i,
  /\.zip$/i, /\.tar$/i, /\.gz$/i, /\.7z$/i, /\.rar$/i,
  /\.env$/i, /\.ini$/i, /\.config$/i, /\.conf$/i,
  /\.log$/i, /\.git\/config$/i, /\.git\/HEAD$/i,
  /\.htaccess$/i, /\.htpasswd$/i,
  /wp-config\.php$/i, /wp-config\.bak$/i,
  /\.pem$/i, /\.key$/i, /\.crt$/i, /\.cer$/i,
  /\.DS_Store$/i, /\.svn\//i, /Thumbs\.db$/i,
  /\/admin\/?$/i, /\/wp-admin\/?$/i, /\/phpmyadmin\/?$/i,
  /\/\.git\/?$/i, /\/\.env\/?$/i,
];

export function isInteresting(url: string): boolean {
  return INTERESTING_PATTERNS.some((pattern) => pattern.test(url));
}

export function splitTerms(raw: string | undefined): { includes: string[]; excludes: string[] } {
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const term of (raw ?? "").split(",")) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("!")) {
      const rest = trimmed.slice(1).trim();
      if (rest) excludes.push(rest);
    } else {
      includes.push(trimmed);
    }
  }
  return { includes, excludes };
}

export function extractHostname(url: string): string {
  if (!url) return "";
  try {
    return new URL(url.includes("://") ? url : `http://${url}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function matchDomainPattern(hostname: string, pattern: string): boolean {
  let candidate = (pattern ?? "").trim().toLowerCase();
  candidate = candidate.replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/^\*\./, "");
  if (!hostname || !candidate) return false;
  return hostname === candidate || hostname.endsWith(`.${candidate}`);
}

export function matchDomainPatterns(url: string, includes: string[], excludes: string[]): boolean {
  const hostname = extractHostname(url);
  if (!hostname) return true;
  if (excludes.some((pattern) => matchDomainPattern(hostname, pattern))) return false;
  if (!includes.length) return true;
  return includes.some((pattern) => matchDomainPattern(hostname, pattern));
}

export function applyFilter(records: ArchiveRecord[], spec: FilterSpec = {}): ArchiveRecord[] {
  let filtered = [...records];
  if (spec.status?.trim()) {
    const { includes, excludes } = splitTerms(spec.status);
    if (includes.length) filtered = filtered.filter((r) => includes.includes(r.statusCode));
    if (excludes.length) filtered = filtered.filter((r) => !excludes.includes(r.statusCode));
  }
  if (spec.fileType?.trim()) {
    const { includes, excludes } = splitTerms(spec.fileType);
    const inc = includes.map((t) => t.toLowerCase());
    const exc = excludes.map((t) => t.toLowerCase());
    if (inc.length) filtered = filtered.filter((r) => inc.every((t) => r.fileType.toLowerCase().includes(t)));
    if (exc.length) filtered = filtered.filter((r) => !exc.some((t) => r.fileType.toLowerCase().includes(t)));
  }
  if (spec.urlKeyword?.trim()) {
    const { includes, excludes } = splitTerms(spec.urlKeyword);
    const inc = includes.map((t) => t.toLowerCase());
    const exc = excludes.map((t) => t.toLowerCase());
    if (inc.length) filtered = filtered.filter((r) => inc.every((t) => r.url.toLowerCase().includes(t)));
    if (exc.length) filtered = filtered.filter((r) => !exc.some((t) => r.url.toLowerCase().includes(t)));
  }
  if (spec.domain?.trim()) {
    const cleaned = spec.domain.replace(/\s*\(\d+\)\s*$/, "").trim();
    const { includes, excludes } = splitTerms(cleaned);
    if (includes.length || excludes.length) {
      filtered = filtered.filter((r) => matchDomainPatterns(r.url, includes, excludes));
    }
  }
  if (spec.interestingOnly) {
    filtered = filtered.filter((r) => isInteresting(r.url));
  }
  return filtered;
}

export function sortRecords(records: ArchiveRecord[], spec: SortSpec = {}): ArchiveRecord[] {
  const column = spec.column ?? "";
  if (!column) return [...records];
  const result = [...records];
  result.sort((a, b) => {
    const left = a[column] ?? "";
    const right = b[column] ?? "";
    let cmp: number;
    if (column === "status_code" || column === "length") {
      cmp = Number.parseInt(left, 10) - Number.parseInt(right, 10);
      if (Number.isNaN(cmp)) cmp = 0;
    } else {
      cmp = String(left).toLowerCase().localeCompare(String(right).toLowerCase());
    }
    return spec.reverse ? -cmp : cmp;
  });
  return result; // Array#sort is stable; equal keys keep receipt order.
}

// ==================== result collection (pure) ====================

export interface AppendOutcome {
  added: number;
  duplicates: number;
  batchDuplicates: number;
  knownDuplicates: number;
  total: number;
}

export class ResultCollection {
  records: ArchiveRecord[] = [];
  urls: Set<string> = new Set();
  revision = 0;

  constructor(records: ArchiveRecord[] = []) {
    this.reset(records);
  }

  reset(records: ArchiveRecord[]): void {
    this.records = [];
    this.urls = new Set();
    this.revision += 1;
    this.appendInternal(records);
    // R1: every reset invalidates derived state, even for an empty batch.
    this.revision += 1;
  }

  clear(): void {
    this.records = [];
    this.urls = new Set();
    this.revision += 1;
  }

  append(records: ArchiveRecord[]): AppendOutcome {
    const outcome = this.appendInternal(records);
    if (outcome.added) this.revision += 1;
    return outcome;
  }

  appendInternal(records: ArchiveRecord[]): AppendOutcome {
    let added = 0;
    let batchDuplicates = 0;
    let knownDuplicates = 0;
    const batchKeys = new Set<string>();
    for (const record of records ?? []) {
      if (record.url) {
        if (batchKeys.has(record.url)) { batchDuplicates += 1; continue; }
        if (this.urls.has(record.url)) { knownDuplicates += 1; continue; }
        batchKeys.add(record.url);
        this.urls.add(record.url);
      }
      this.records.push(record);
      added += 1;
    }
    return {
      added,
      duplicates: batchDuplicates + knownDuplicates,
      batchDuplicates,
      knownDuplicates,
      total: this.records.length,
    };
  }

  view(filter: FilterSpec = {}, sort: SortSpec = {}): ArchiveRecord[] {
    return sortRecords(applyFilter(this.records, filter), sort);
  }

  page(pageIndex: number, pageSize: number, filter: FilterSpec = {}, sort: SortSpec = {}): ArchiveRecord[] {
    if (pageIndex < 0 || pageSize <= 0) return [];
    const view = this.view(filter, sort);
    const start = pageIndex * pageSize;
    return view.slice(start, start + pageSize);
  }

  pageCount(pageSize: number, filter: FilterSpec = {}, sort: SortSpec = {}): number {
    const total = this.view(filter, sort).length;
    return total ? Math.ceil(total / pageSize) : 0;
  }

  snapshot(filter: FilterSpec = {}, sort: SortSpec = {}): Record<string, string>[] {
    return this.view(filter, sort).map(toExportRow);
  }
}

// ==================== export ====================

export const EXPORT_FIELDS = ["timestamp", "status_code", "length", "file_type", "url"] as const;

export function toExportRow(record: ArchiveRecord): Record<string, string> {
  return {
    timestamp: record.timestamp,
    status_code: record.statusCode,
    length: record.length,
    file_type: record.fileType,
    url: record.url,
  };
}

function csvQuote(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function serializeCsv(records: ArchiveRecord[]): Buffer {
  const lines = [EXPORT_FIELDS.join(",")];
  for (const record of records) {
    const row = toExportRow(record);
    lines.push(EXPORT_FIELDS.map((field) => csvQuote(row[field])).join(","));
  }
  return Buffer.from(`﻿${lines.join("\r\n")}\r\n`, "utf8");
}

export function serializeJson(records: ArchiveRecord[]): Buffer {
  const rows = records.map(toExportRow);
  return Buffer.from(JSON.stringify(rows, null, 2), "utf8");
}

export function writeExportAtomically(records: ArchiveRecord[], filepath: string, format: ExportFormat): void {
  const payload = format === "csv" ? serializeCsv(records) : serializeJson(records);
  const target = path.resolve(filepath);
  mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.archrecon-acceptance-${process.pid}-${Date.now()}.${format}`);
  try {
    writeFileSync(temp, payload);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

// ==================== IUT ====================

interface Job {
  id: number;
  source: Source;
  status: JobStatus;
  config: FrozenJobConfig;
  records: ArchiveRecord[];
  urls: Set<string>;
  revision: number;
  seq: number;
  received: number;
  reasons: string[];
  stopRequested: boolean;
  indexCursor: number;
  ccIndexes: string[];
  ccPage: number;
  totalPages: number;
  terminal: boolean;
  failedIndexes: string[];
  truncatedIndexes: string[];
}

interface IutState {
  options: IutOptions;
  mode: "reference" | "legacy";
  jobs: Map<number, Job>;
  activeId: number;
  nextId: number;
  events: JobEvent[];
  pending: JobEvent[];
  listeners: ((event: JobEvent) => void)[];
  closed: boolean;
  currentInput: string;
  legacyStaleRecords: ArchiveRecord[] | null;
  legacyStaleRevision: number;
  legacyStaleCounts: { received: number; unique: number } | null;
}

const state = new WeakMap<Iut, IutState>();

function getState(iut: Iut): IutState {
  const value = state.get(iut);
  if (!value) throw new Error("IUT not initialized");
  return value;
}

export function createIut(options: IutOptions): Iut {
  const mode = options.mode ?? "reference";
  const s: IutState = {
    options,
    mode,
    jobs: new Map(),
    activeId: 0,
    nextId: 0,
    events: [],
    pending: [],
    listeners: [],
    closed: false,
    currentInput: "",
    legacyStaleRecords: null,
    legacyStaleRevision: 0,
    legacyStaleCounts: null,
  };

  const iut: Iut = {
    startQuery(request) {
      if (s.closed) return fail("CLOSED", "窗口已关闭");
      if (s.activeId) {
        const active = s.jobs.get(s.activeId);
        if (active && !active.terminal) return fail("BUSY", "已有查询任务在运行");
      }
      const target = mode === "legacy" ? normalizeTargetLegacy(request.target) : normalizeTarget(request.target);
      if (!target.ok) return target;
      if (!SOURCES.has(request.source)) return fail("INVALID_INPUT", "未知来源");
      const range = validateRange(request.range);
      if (!range.ok) return range;
      const proxy = validateProxy(request.proxy ?? { mode: "direct" });
      if (!proxy.ok) return proxy;

      const config: FrozenJobConfig = {
        target: target.value,
        source: request.source,
        range: range.value,
        clockUtc: new FixedClock(options.clockUtc).iso,
        proxy: proxy.value,
        budgets: BUDGETS,
      };
      const job: Job = {
        id: ++s.nextId,
        source: request.source,
        status: "preparing",
        config,
        records: [],
        urls: new Set(),
        revision: 0,
        seq: 0,
        received: 0,
        reasons: [],
        stopRequested: false,
        indexCursor: 0,
        ccIndexes: [],
        ccPage: 0,
        totalPages: 0,
        terminal: false,
        failedIndexes: [],
        truncatedIndexes: [],
      };
      s.jobs.set(job.id, job);
      s.activeId = job.id;
      s.currentInput = request.target;
      emit(s, job, "state", { status: job.status, scope: config.target });
      if (mode === "legacy") {
        // Legacy collection cache survives a reset (R1).
        if (s.legacyStaleRecords === null) {
          s.legacyStaleRecords = null;
        }
      }
      void runJob(s, iut, job);
      return ok({ jobId: job.id, source: job.source, frozenScope: config.target });
    },

    cancelQuery(jobId, source) {
      const job = s.jobs.get(jobId);
      if (!job) return fail("NOT_FOUND", "任务不存在");
      if (mode !== "legacy" && job.source !== source) return fail("INVALID_INPUT", "来源与任务不匹配");
      if (job.terminal) return ok({ jobId, status: job.status });
      if (!job.stopRequested) {
        job.stopRequested = true;
        job.status = "stopping";
        emit(s, job, "state", { status: job.status });
      }
      return ok({ jobId, status: job.status });
    },

    getView(jobId, source, filter = {}, sort = {}, pageIndex = 0, pageSize = 50) {
      const job = s.jobs.get(jobId);
      if (!job) return fail("NOT_FOUND", "任务不存在");
      if (mode !== "legacy" && job.source !== source) return fail("INVALID_INPUT", "来源与任务不匹配");
      const size = Math.max(1, Math.trunc(pageSize) || 50);
      const index = Math.max(0, Math.trunc(pageIndex) || 0);

      let records = job.records;
      if (mode === "legacy" && s.legacyStaleRecords !== null && job.revision === 0) {
        // Stale collection cache from the previous query.
        records = s.legacyStaleRecords;
      }
      const view = sortRecords(applyFilter(records, filter), sort);
      const start = index * size;
      const rows = view.slice(start, start + size);
      const pageCount = view.length ? Math.ceil(view.length / size) : 0;

      if (mode === "reference" && job.records.length) {
        s.legacyStaleRecords = [...job.records];
        s.legacyStaleRevision = job.revision;
      }
      if (mode === "legacy" && job.records.length) {
        s.legacyStaleRecords = [...job.records];
        s.legacyStaleRevision = job.revision;
      }

      return ok({
        jobId,
        source: job.source,
        revision: job.revision,
        rows,
        received: job.received,
        unique: job.records.length,
        matched: view.length,
        pageCount,
        pageIndex: index,
        pageSize: size,
        scope: job.config.target,
        status: job.status,
        reasons: [...job.reasons],
        range: job.config.range,
      });
    },

    exportResults(request) {
      const job = s.jobs.get(request.jobId);
      if (!job) return fail("NOT_FOUND", "任务不存在");
      if (mode !== "legacy" && job.source !== request.source) return fail("INVALID_INPUT", "来源与任务不匹配");
      if (request.expectedRevision !== job.revision) {
        return fail("STALE_VIEW", "结果已变化，请刷新后重试");
      }
      if (options.cancelExport?.()) {
        return ok({ cancelled: true, saved: false, count: 0 });
      }
      const sourceRecords = mode === "legacy" && job.revision === 0 && s.legacyStaleRecords !== null
        ? s.legacyStaleRecords
        : job.records;
      const view = sortRecords(applyFilter(sourceRecords, request.filter ?? {}), request.sort ?? {});
      const target = request.path ?? options.defaultExportPath;
      if (!target) return fail("EXPORT", "未提供导出路径");
      try {
        writeExportAtomically(view, target, request.format);
        return ok({ cancelled: false, saved: true, count: view.length, path: target });
      } catch (error) {
        return fail("EXPORT", `写入文件失败：${(error as Error).message}`);
      }
    },

    scrollCc(jobId) {
      const id = jobId ?? s.activeId;
      const job = s.jobs.get(id);
      if (mode === "legacy") {
        // Source-blind: even a Wayback job triggers a CC page (R4).
        if (!job) return ok({ accepted: false });
        void fetchCcPageForJob(s, job, job.ccIndexes[0] ?? "CC-MAIN-LEGACY", job.ccPage + 1).catch(() => undefined);
        return ok({ accepted: true });
      }
      if (!job || job.source !== "commoncrawl" || job.terminal) {
        return ok({ accepted: false });
      }
      return ok({ accepted: false }); // Scroll only pages locally; no new source work.
    },

    setTargetInput(value) {
      s.currentInput = value;
    },

    subscribe(listener) {
      s.listeners.push(listener);
      return () => {
        s.listeners = s.listeners.filter((item) => item !== listener);
      };
    },

    close() {
      if (s.closed) return;
      s.closed = true;
      const active = s.jobs.get(s.activeId);
      if (active && !active.terminal) {
        active.stopRequested = true;
        active.status = "stopped";
        active.terminal = true;
        active.revision += 1;
      }
      if (mode !== "legacy") {
        s.listeners = [];
        s.pending = [];
      } else if (active) {
        // R5 sensitivity: a worker callback still reaches the UI after close.
        setTimeout(() => emit(s, active, "state", { status: "stopped", lateAfterClose: true }), 5);
      }
    },

    async flushEvents() {
      const delivered = [...s.pending];
      s.pending = [];
      if (mode !== "legacy" && !s.closed) {
        for (const event of delivered) {
          for (const listener of s.listeners) listener(event);
        }
      }
      return delivered;
    },

    eventsFor(jobId) {
      return s.events.filter((event) => event.jobId === jobId);
    },

    getStatus(jobId) {
      return s.jobs.get(jobId)?.status;
    },

    getFrozenConfig(jobId) {
      return s.jobs.get(jobId)?.config;
    },
  };

  state.set(iut, s);
  return iut;
}

// ==================== job execution ====================

async function runJob(s: IutState, iut: Iut, job: Job): Promise<void> {
  job.status = "running";
  emit(s, job, "state", { status: job.status });
  try {
    if (job.source === "wayback") {
      await runWayback(s, iut, job);
    } else {
      await runCommonCrawl(s, iut, job);
    }
  } catch (error) {
    if (s.closed) return;
    if (error instanceof ProxyFailure) {
      if (s.mode === "legacy") {
        // Legacy: fall back to a direct request after proxy failure.
        try {
          await s.options.transport.fetchText({
            source: job.source,
            kind: "wayback-page",
            url: waybackUrl(job, 0),
            jobId: job.id,
            proxy: { mode: "direct" },
            page: 0,
          });
        } catch {
          // ignore
        }
        job.reasons.push("proxy-failed-direct-fallback");
        finalize(s, job, "failed", "代理连接失败");
        return;
      }
      job.reasons.push("proxy-connect-refused");
      finalize(s, job, "failed", `代理连接失败：${error.message}`);
      return;
    }
    const message = (error as Error).message ?? String(error);
    finalize(s, job, job.records.length ? "partial" : "failed", message);
  }
}

async function runWayback(s: IutState, iut: Iut, job: Job): Promise<void> {
  for (let page = 0; page < BUDGETS.waybackPages; page += 1) {
    if (job.stopRequested) return finishStopped(s, job);
    const response = await s.options.transport.fetchText({
      source: "wayback",
      kind: "wayback-page",
      url: waybackUrl(job, page),
      jobId: job.id,
      proxy: job.config.proxy,
      page,
    });
    if (s.closed) return;
    const parsed = parseWaybackResponse(response.text, job);
    if (job.stopRequested) {
      if (s.mode === "legacy" && (!parsed.hasMore || !parsed.records.length)) {
        // Legacy R2: final/empty page leaves the job in stopping.
        return;
      }
      return finishStopped(s, job);
    }
    if (!parsed.records.length) {
      if (job.stopRequested) return finishStopped(s, job);
      return finalize(s, job, "completed");
    }
    appendRecords(job, parsed.records);
    emit(s, job, "progress", { page, received: job.received, unique: job.records.length });
    emit(s, job, "viewChanged", { revision: job.revision });
    if (job.stopRequested) return finishStopped(s, job);
    if (!parsed.hasMore) {
      if (job.stopRequested) return finishStopped(s, job);
      return finalize(s, job, "completed");
    }
  }
  job.reasons.push("已读满 20 页上限");
  finalize(s, job, "partial", "已读满 20 页上限");
}

function waybackUrl(job: Job, page: number): string {
  const scope = job.config.target;
  const params = new URLSearchParams({
    url: scope.host,
    matchType: scope.match,
    output: "json",
    fl: "urlkey,timestamp,original,mimetype,statuscode,digest,length",
    collapse: "urlkey",
    limit: String(BUDGETS.waybackPageSize),
  });
  if (page > 0) params.set("page", String(page));
  return `https://web.archive.org/cdx/search/cdx?${params.toString()}`;
}

async function runCommonCrawl(s: IutState, iut: Iut, job: Job): Promise<void> {
  const collinfo = await s.options.transport.fetchText({
    source: "commoncrawl",
    kind: "cc-collinfo",
    url: "https://index.commoncrawl.org/collinfo.json",
    jobId: job.id,
    proxy: job.config.proxy,
  });
  const entries = parseCollInfo(collinfo.text);
  const selection = selectIndexes(entries, job.config.range, job.config.clockUtc);
  for (const item of selection.unknown) {
    job.reasons.push(item.reason);
    emit(s, job, "reason", { reason: item.reason });
  }
  if (!selection.selected.length) {
    job.reasons.push("所选时间范围内没有可用索引");
    return finalize(s, job, "completed", "所选时间范围内没有可用索引");
  }
  job.ccIndexes = selection.selected.map((item) => item.entry.id);

  for (let cursor = 0; cursor < selection.selected.length; cursor += 1) {
    job.indexCursor = cursor;
    const entry = selection.selected[cursor];
    const target = s.mode === "legacy" ? s.currentInput : job.config.target.input; // R3
    if (job.stopRequested) return finishStopped(s, job);

    let totalPages = 0;
    try {
      const count = await s.options.transport.fetchText({
        source: "commoncrawl",
        kind: "cc-page-count",
        url: ccPageCountUrl(entry.entry.id, target, job.config.proxy),
        jobId: job.id,
        proxy: job.config.proxy,
        indexId: entry.entry.id,
      });
      totalPages = Math.max(0, Number(JSON.parse(count.text).pages ?? 0));
    } catch (error) {
      if (error instanceof ProxyFailure) throw error;
      job.failedIndexes.push(entry.entry.id);
      job.reasons.push(`${entry.entry.id}: 页数查询失败`);
      continue;
    }
    job.totalPages = totalPages;
    const pages = Math.min(totalPages, BUDGETS.ccPagesPerIndex);
    let fetched = 0;
    for (let page = 0; page < pages; page += 1) {
      if (job.stopRequested) return finishStopped(s, job);
      let response;
      try {
        response = await s.options.transport.fetchText({
          source: "commoncrawl",
          kind: "cc-page",
          url: ccPageUrl(entry.entry.id, target, page),
          jobId: job.id,
          proxy: job.config.proxy,
          page,
          indexId: entry.entry.id,
        });
      } catch (error) {
        if (error instanceof ProxyFailure) throw error;
        job.failedIndexes.push(entry.entry.id);
        job.reasons.push(`${entry.entry.id}: 第 ${page} 页请求失败`);
        break;
      }
      if (job.stopRequested) {
        if (s.mode === "legacy" && (page === pages - 1 || response.text.trim() === "")) {
          return; // R2 legacy
        }
        return finishStopped(s, job);
      }
      const records = parseCcRecords(response.text, entry.entry.id, job);
      if (!records.length) {
        fetched += 1;
        break;
      }
      appendRecords(job, records);
      fetched += 1;
      emit(s, job, "progress", { indexId: entry.entry.id, page, received: job.received, unique: job.records.length });
      emit(s, job, "viewChanged", { revision: job.revision });
    }
    if (fetched < pages) {
      job.truncatedIndexes.push(entry.entry.id);
      job.reasons.push(`${entry.entry.id}: 达到 5 页上限`);
    }
    if (job.stopRequested) return finishStopped(s, job);
  }

  if (job.failedIndexes.length || job.truncatedIndexes.length) {
    finalize(s, job, "partial", job.reasons.join("；") || "部分索引未完成");
  } else {
    finalize(s, job, "completed");
  }
}

function ccPageCountUrl(indexId: string, targetInput: string, proxy: ProxyConfig): string {
  const host = targetInput.replace(/^https?:\/\//, "").replace(/^\*\./, "").replace(/\/$/, "");
  const params = new URLSearchParams({
    url: `*.${host}`,
    output: "json",
    pageSize: String(BUDGETS.ccPageSize),
    showNumPages: "true",
  });
  return `https://index.commoncrawl.org/${indexId}-index?${params.toString()}`;
}

function ccPageUrl(indexId: string, targetInput: string, page: number): string {
  const host = targetInput.replace(/^https?:\/\//, "").replace(/^\*\./, "").replace(/\/$/, "");
  const params = new URLSearchParams({
    url: `*.${host}`,
    output: "json",
    page: String(page),
    pageSize: String(BUDGETS.ccPageSize),
  });
  return `https://index.commoncrawl.org/${indexId}-index?${params.toString()}`;
}

async function fetchCcPageForJob(s: IutState, job: Job, indexId: string, page: number): Promise<void> {
  const target = s.currentInput; // legacy path
  await s.options.transport.fetchText({
    source: "commoncrawl",
    kind: "cc-page",
    url: ccPageUrl(indexId, target, page),
    jobId: job.id,
    proxy: job.config.proxy,
    page,
    indexId,
  });
}

// ==================== parsing ====================

function parseWaybackResponse(text: string, job: Job): { records: ArchiveRecord[]; hasMore: boolean } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Wayback 响应不是合法 JSON");
  }
  if (!Array.isArray(data) || data.length < 2) return { records: [], hasMore: false };
  const header = data[0] as string[];
  const rows = data.slice(1) as unknown[][];
  const records = rows.map((row, index) => {
    const raw: Record<string, unknown> = {};
    header.forEach((key, i) => { raw[key] = row[i]; });
    return makeRecord({
      url: String(raw.original ?? ""),
      statusCode: String(raw.statuscode ?? ""),
      length: String(raw.length ?? ""),
      fileType: String(raw.mimetype ?? "").split(";")[0].trim() || "unknown",
      rawTimestamp: String(raw.timestamp ?? ""),
      source: "wayback",
      indexId: "",
      job,
      index,
    });
  });
  const hasMore = records.length >= BUDGETS.waybackPageSize;
  return { records, hasMore };
}

function parseCcRecords(text: string, indexId: string, job: Job): ArchiveRecord[] {
  const records: ArchiveRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Deliberately mirrors the production adapter: malformed lines are
      // skipped, and the incompleteness count is a separate contract item.
      continue;
    }
    records.push(makeRecord({
      url: String(raw.url ?? ""),
      statusCode: String(raw.status ?? ""),
      length: String(raw.length ?? ""),
      fileType: String(raw.mime ?? "").split(";")[0].trim() || "unknown",
      rawTimestamp: String(raw.timestamp ?? ""),
      source: "commoncrawl",
      indexId,
      job,
      index: records.length,
    }));
  }
  return records;
}

function parseCollInfo(text: string): CollInfoEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("collinfo 响应不是合法 JSON");
  }
  if (!Array.isArray(data)) throw new Error("collinfo 响应不是数组");
  return data.map((item) => {
    const row = item as Record<string, unknown>;
    return {
      id: String(row.id ?? ""),
      name: row.name === undefined ? undefined : String(row.name),
      cdxApi: row["cdx-api"] === undefined ? undefined : String(row["cdx-api"]),
      from: row.from === null || row.from === undefined ? null : String(row.from),
      to: row.to === null || row.to === undefined ? null : String(row.to),
    };
  });
}

function makeRecord(input: {
  url: string; statusCode: string; length: string; fileType: string;
  rawTimestamp: string; source: Source; indexId: string; job: Job; index: number;
}): ArchiveRecord {
  return {
    url: input.url,
    statusCode: input.statusCode,
    length: input.length,
    fileType: input.fileType,
    timestamp: formatTimestamp(input.rawTimestamp),
    source: input.source,
    rawTimestamp: input.rawTimestamp,
    indexId: input.indexId,
    rowId: `${input.job.id}:${input.source}:${input.job.received + input.index}`,
  };
}

export function formatTimestamp(raw: string): string {
  if (raw.length >= 8) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return raw;
}

// ==================== state helpers ====================

function appendRecords(job: Job, records: ArchiveRecord[]): void {
  const batchKeys = new Set<string>();
  let added = 0;
  for (const record of records) {
    if (record.url) {
      if (batchKeys.has(record.url)) continue;
      if (job.urls.has(record.url)) continue;
      batchKeys.add(record.url);
      job.urls.add(record.url);
    }
    job.records.push(record);
    added += 1;
  }
  job.received += records.length;
  if (added) job.revision += 1;
}

function finishStopped(s: IutState, job: Job): void {
  finalize(s, job, "stopped", "用户停止");
}

function finalize(s: IutState, job: Job, status: JobStatus, reason?: string): void {
  if (job.terminal) return;
  if (status === "completed" && job.reasons.length) status = "partial";
  job.status = status;
  job.terminal = true;
  job.revision += 1;
  if (reason) job.reasons.push(reason);
  emit(s, job, "state", { status, reason: reason ?? "" });
}

function emit(s: IutState, job: Job, kind: JobEvent["kind"], payload: Record<string, unknown>): void {
  job.seq += 1;
  const event: JobEvent = {
    schemaVersion: 1,
    jobId: job.id,
    source: job.source,
    seq: job.seq,
    revision: job.revision,
    kind,
    payload,
  };
  s.events.push(event);
  if (s.mode === "legacy") {
    for (const listener of s.listeners) listener(event); // R5: delivers after close too.
  } else {
    s.pending.push(event);
  }
}

function validateRange(range: TimeRange): Result<TimeRange> {
  if (range.kind === "months") {
    if (!Number.isInteger(range.months) || range.months < 1 || range.months > 120) {
      return fail("INVALID_INPUT", "月份数量必须在 1 到 120 之间");
    }
    return ok(range);
  }
  if (range.kind === "month") {
    if (!Number.isInteger(range.year) || range.year < 2013 || range.year > 2100 ||
        !Number.isInteger(range.month) || range.month < 1 || range.month > 12) {
      return fail("INVALID_INPUT", "指定年月无效");
    }
    return ok(range);
  }
  if (range.kind === "all") return ok(range);
  return fail("INVALID_INPUT", "时间范围无效");
}

function validateProxy(proxy: ProxyConfig): Result<ProxyConfig> {
  if (!["direct", "system", "fixed"].includes(proxy.mode)) {
    return fail("INVALID_INPUT", "代理模式无效");
  }
  if (proxy.mode === "fixed") {
    if (!proxy.url || !/^(https?|socks5):\/\//i.test(proxy.url)) {
      return fail("INVALID_INPUT", "固定代理地址无效");
    }
  }
  return ok(proxy);
}

function normalizeTargetLegacy(input: string): Result<FrozenScope> {
  // Reproduces the known 6349a0e acceptance gaps for sensitivity evidence.
  const value = (input ?? "").trim();
  if (!value) return fail("INVALID_INPUT", "请输入目标域名");
  let host = value.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (host.includes("@")) host = host.slice(host.lastIndexOf("@") + 1);
  if (host.includes("/") || host.includes("?") || host.includes("#") || /:\d+$/.test(host)) {
    return fail("INVALID_INPUT", "路径、查询、片段或端口不允许");
  }
  const hostOnly = host.replace(/^\*\./, "");
  return ok({ input: host, host: hostOnly, wildcard: host.startsWith("*."), match: "domain" });
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T = never>(code: AppError["code"], message: string, source?: Source): Result<T> {
  return { ok: false, error: { code, message, source } };
}
