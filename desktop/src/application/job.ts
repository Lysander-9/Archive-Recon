/** Task lifecycle, frozen config, result ownership and view projection. */

import {
  CC_BUDGET,
  EMPTY_FILTER,
  SCHEMA_VERSION,
  WAYBACK_BUDGET,
  type CancelQueryRequest,
  type CopyRequest,
  type ExportRequest,
  type ExportField,
  type FilterSpec,
  type FrozenJobConfig,
  type GetViewRequest,
  type JobEventDto,
  type JobScopeView,
  type JobStatus,
  type JobView,
  type ProxySpec,
  type RangeSpec,
  type ReasonDto,
  type Result,
  type SortSpec,
  type SourceId,
  type StartQueryRequest,
} from "../contracts/types";
import { ResultCollection } from "../domain/results";
import { selectIndexes, resolveRange, type CcIndexMeta } from "../domain/time";
import { normalizeTarget } from "../domain/target";
import { toExportRow, type ArchiveRecord } from "../domain/record";
import { AppError, errorFromUnknown, isTerminal } from "./errors";
import type { JobDeps, JobSession, RequestOptions } from "./ports";

interface JobRuntime {
  id: number;
  source: SourceId;
  config: FrozenJobConfig;
  collection: ResultCollection;
  status: JobStatus;
  seq: number;
  received: number;
  reasons: ReasonDto[];
  completion: "complete" | "partial" | "unknown";
  terminal: boolean;
  controller: AbortController;
  session: JobSession;
  lastError?: AppError;
}

const BUSY_MESSAGE = "当前已有查询任务在运行，请等待完成或先停止。";

function budgetLabel(source: SourceId): string {
  if (source === "wayback") {
    return `Wayback 最多 ${WAYBACK_BUDGET.maxPages} 页 × ${WAYBACK_BUDGET.pageSize} 条`;
  }
  return `Common Crawl 每索引最多 ${CC_BUDGET.maxPagesPerIndex} 页（pageSize=${CC_BUDGET.pageSize} 个压缩索引块）`;
}

export class JobManager {
  private jobs = new Map<number, JobRuntime>();
  private nextId = 1;
  private activeId: number | null = null;

  constructor(private readonly deps: JobDeps) {}

  get activeJobId(): number | null {
    return this.activeId;
  }

  activeJob(): { id: number; source: SourceId; status: JobStatus } | null {
    if (this.activeId === null) return null;
    const job = this.jobs.get(this.activeId);
    if (!job) return null;
    return { id: job.id, source: job.source, status: job.status };
  }

  async start(request: StartQueryRequest): Promise<Result<{ jobId: number; source: SourceId; scope: JobScopeView }>> {
    if (this.activeId !== null) {
      const active = this.jobs.get(this.activeId);
      if (active && !active.terminal) {
        const busy = new AppError("BUSY", BUSY_MESSAGE);
        return { ok: false, error: busy.toDto() };
      }
    }

    const target = normalizeTarget(request.target);
    if (!target.ok) {
      return { ok: false, error: { code: "INVALID_INPUT", message: target.message } };
    }
    const range: RangeSpec = request.range;
    const clock = this.deps.clock();
    const selection = resolveRange(range, clock);
    const jobId = this.nextId++;

    let session: JobSession;
    try {
      session = await this.deps.sessions.create(jobId, request.proxy);
    } catch (error) {
      const failure = error instanceof AppError ? error : errorFromUnknown(error, request.source);
      return { ok: false, error: failure.toDto() };
    }

    const config: FrozenJobConfig = {
      target: target.scope,
      source: request.source,
      range,
      clockUtc: clock.toISOString(),
      selection,
      proxy: session.proxy,
      budget:
        request.source === "wayback"
          ? { maxPages: WAYBACK_BUDGET.maxPages, pageSize: WAYBACK_BUDGET.pageSize }
          : { maxPages: CC_BUDGET.maxPagesPerIndex, pageSize: CC_BUDGET.pageSize },
    };

    const job: JobRuntime = {
      id: jobId,
      source: request.source,
      config,
      collection: new ResultCollection(),
      status: "preparing",
      seq: 0,
      received: 0,
      reasons: [],
      completion: "unknown",
      terminal: false,
      controller: new AbortController(),
      session,
    };
    this.jobs.set(jobId, job);
    this.activeId = jobId;
    this.emitState(job, "preparing");

    void this.run(job);
    return { ok: true, value: { jobId, source: job.source, scope: this.scopeOf(job) } };
  }

  cancel(request: CancelQueryRequest): Result<{ status: JobStatus }> {
    const job = this.jobs.get(request.jobId);
    if (!job || job.source !== request.source) {
      return { ok: false, error: { code: "STALE_VIEW", message: "任务不存在或已被替换" } };
    }
    if (job.terminal) {
      return { ok: true, value: { status: job.status } };
    }
    if (job.status !== "stopping") {
      job.status = "stopping";
      this.emitState(job, "stopping");
    }
    job.controller.abort();
    return { ok: true, value: { status: job.status } };
  }

  getView(request: GetViewRequest): Result<JobView> {
    const job = this.jobs.get(request.jobId);
    if (!job || job.source !== request.source) {
      return { ok: false, error: { code: "STALE_VIEW", message: "任务不存在或已被替换" } };
    }
    job.collection.setFilter(request.filter);
    job.collection.setSort(request.sort);
    const page = job.collection.page(request.pageIndex, request.pageSize);
    return {
      ok: true,
      value: this.buildView(job, page.rows, page.pageIndex, request.pageSize, page.pageCount),
    };
  }

  /** Immutable export snapshot; revision is checked before reading. */
  exportSnapshot(
    request: ExportRequest,
  ): Result<{ rows: Array<Record<ExportField, string>>; revision: number }> {
    const job = this.jobs.get(request.jobId);
    if (!job || job.source !== request.source) {
      return { ok: false, error: { code: "STALE_VIEW", message: "任务不存在或已被替换" } };
    }
    if (job.collection.revision !== request.expectedRevision) {
      return {
        ok: false,
        error: { code: "STALE_VIEW", message: "结果已更新，请刷新后重新导出" },
      };
    }
    job.collection.setFilter(request.filter);
    job.collection.setSort(request.sort);
    return {
      ok: true,
      value: { rows: job.collection.snapshot(), revision: job.collection.revision },
    };
  }

  copy(request: CopyRequest): Result<{ copiedCount: number; text: string }> {
    const job = this.jobs.get(request.jobId);
    if (!job || job.source !== request.source) {
      return { ok: false, error: { code: "STALE_VIEW", message: "任务不存在或已被替换" } };
    }
    if (job.collection.revision !== request.revision) {
      return { ok: false, error: { code: "STALE_VIEW", message: "结果已更新，请刷新后重试" } };
    }
    const records = job.collection.recordsByIds(request.rowIds);
    const text = records
      .map((record) =>
        request.mode === "url" ? record.url : this.rowText(record),
      )
      .join("\r\n");
    return { ok: true, value: { copiedCount: records.length, text } };
  }

  closeAll(): void {
    for (const job of this.jobs.values()) {
      if (!job.terminal) {
        job.controller.abort();
        job.terminal = true;
        job.status = "stopped";
        job.completion = job.collection.matched() > 0 ? "partial" : "unknown";
      }
    }
  }

  private rowText(record: ArchiveRecord): string {
    return [record.timestamp, record.statusCode, record.length, record.fileType, record.url].join("\t");
  }

  private scopeOf(job: JobRuntime): JobScopeView {
    const target = job.config.target;
    return {
      host: target.host,
      label: target.label,
      match: target.match,
      rangeLabel: job.config.selection.window ? job.config.selection.window.label : "全部时间",
      clockUtc: job.config.clockUtc,
      proxyDisplay: job.config.proxy.display,
      budgetLabel: budgetLabel(job.source),
    };
  }

  private buildView(
    job: JobRuntime,
    rows: JobView["rows"],
    pageIndex: number,
    pageSize: number,
    pageCount: number,
  ): JobView {
    return {
      schemaVersion: SCHEMA_VERSION,
      jobId: job.id,
      source: job.source,
      revision: job.collection.revision,
      status: job.status,
      rows,
      received: job.received,
      unique: job.collection.total,
      matched: job.collection.matched(),
      total: job.collection.total,
      pageIndex,
      pageSize: pageSize,
      pageCount,
      scope: this.scopeOf(job),
      reasons: job.reasons.map((reason) => ({ ...reason })),
      completion: job.completion,
      terminal: job.terminal,
    };
  }

  private async run(job: JobRuntime): Promise<void> {
    const options = {
      signal: job.controller.signal,
      timeoutMs: 30_000,
      transport: job.session.transport,
    };
    try {
      this.setStatus(job, "running");
      if (job.source === "wayback") {
        await this.runWayback(job, options);
      } else {
        await this.runCommonCrawl(job, options);
      }
    } catch (error) {
      if (job.controller.signal.aborted) {
        job.completion = "partial";
      } else {
        job.lastError = errorFromUnknown(error, job.source);
        job.reasons.push({
          code: job.lastError.code === "TIMEOUT" ? "network" : "network",
          message: job.lastError.message,
          source: job.source,
          retryable: job.lastError.retryable,
        });
        this.emitReason(job, job.reasons[job.reasons.length - 1]);
        job.completion = job.received > 0 ? "partial" : "unknown";
      }
    } finally {
      await this.finish(job);
    }
  }

  private async runWayback(job: JobRuntime, options: RequestOptions): Promise<void> {
    const { maxPages, pageSize } = WAYBACK_BUDGET;
    const host = job.config.target.host;
    for (let page = 0; page < maxPages; page += 1) {
      if (options.signal.aborted) return;
      let result;
      try {
        result = await this.deps.wayback.queryPage(host, page, pageSize, options);
      } catch (error) {
        if (options.signal.aborted) return;
        if (job.received === 0) throw error;
        const reason: ReasonDto = {
          code: "network",
          message: `第 ${page + 1} 页读取失败，已保留前面结果`,
          source: "wayback",
          page,
          retryable: true,
        };
        this.addReason(job, reason);
        job.completion = "partial";
        return;
      }
      if (result.records.length === 0) break;
      const outcome = job.collection.append(result.records);
      job.received += result.records.length;
      for (const reason of result.reasons) this.addReason(job, reason);
      this.emitProgress(job, { page: page + 1, added: outcome.added });
      if (!result.hasMore) break;
      if (page === maxPages - 1) {
        this.addReason(job, {
          code: "page_limit",
          message: `已读满 ${maxPages} 页，可能仍有更多存档`,
          source: "wayback",
          page,
        });
        job.completion = "partial";
      }
      await this.wait(400, options.signal);
    }
  }

  private async runCommonCrawl(job: JobRuntime, options: RequestOptions): Promise<void> {
    const host = job.config.target.host;
    const { metas } = await this.deps.commoncrawl.fetchIndexes(options);
    const selection = selectIndexes(metas, job.config.selection);
    if (selection.unknownExcluded > 0) {
      this.addReason(job, {
        code: "range_unknown",
        message: `${selection.unknownExcluded} 个索引缺少官方时间元数据，已排除`,
        source: "commoncrawl",
        count: selection.unknownExcluded,
      });
      job.completion = "partial";
    }
    if (selection.unknownIncluded) {
      const unknownCount = selection.indexes.filter((index) => index.unknown).length;
      this.addReason(job, {
        code: "range_unknown",
        message: `${unknownCount} 个索引的时间范围未知；已按全部时间保留`,
        source: "commoncrawl",
        count: unknownCount,
      });
      job.completion = "partial";
    }
    if (selection.indexes.length === 0) {
      if (job.config.selection.window) {
        job.completion = "complete";
      } else {
        job.completion = "unknown";
        this.addReason(job, {
          code: "range_unknown",
          message: "没有可用的官方索引元数据，范围未知",
          source: "commoncrawl",
        });
      }
      return;
    }
    for (const index of selection.indexes) {
      if (options.signal.aborted) return;
      await this.runOneIndex(job, index, host, options);
    }
  }

  private async runOneIndex(
    job: JobRuntime,
    index: CcIndexMeta,
    host: string,
    options: RequestOptions,
  ): Promise<void> {
    let totalPages: number;
    try {
      totalPages = await this.deps.commoncrawl.pageCount(index, host, options);
    } catch (error) {
      if (options.signal.aborted) return;
      this.addReason(job, {
        code: "network",
        message: `索引 ${index.id} 页数查询失败`,
        source: "commoncrawl",
        indexId: index.id,
        retryable: true,
      });
      job.completion = "partial";
      return;
    }
    if (totalPages <= 0) return;
    const pagesToFetch = Math.min(totalPages, CC_BUDGET.maxPagesPerIndex);
    for (let page = 0; page < pagesToFetch; page += 1) {
      if (options.signal.aborted) return;
      let result;
      try {
        result = await this.deps.commoncrawl.queryPage(index, host, page, CC_BUDGET.pageSize, options);
      } catch (error) {
        if (options.signal.aborted) return;
        this.addReason(job, {
          code: "network",
          message: `索引 ${index.id} 第 ${page + 1} 页读取失败`,
          source: "commoncrawl",
          indexId: index.id,
          page,
          retryable: true,
        });
        job.completion = "partial";
        return;
      }
      const outcome = job.collection.append(
        result.records.map((item) => ({ ...item, indexId: index.id })),
      );
      job.received += result.records.length;
      for (const reason of result.reasons) this.addReason(job, reason);
      this.emitProgress(job, { indexId: index.id, page: page + 1, added: outcome.added });
      if (result.records.length === 0) break;
      if (page < pagesToFetch - 1) await this.wait(1_000, options.signal);
    }
    if (pagesToFetch < totalPages) {
      this.addReason(job, {
        code: "page_limit",
        message: `索引 ${index.id} 达到 ${CC_BUDGET.maxPagesPerIndex} 页上限`,
        source: "commoncrawl",
        indexId: index.id,
      });
      job.completion = "partial";
    }
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private finish(job: JobRuntime): void {
    if (job.terminal) return;
    let status: JobStatus;
    let completion: "complete" | "partial" | "unknown";
    const networkFailureWithoutData =
      job.received === 0 && job.reasons.some((reason) => reason.code === "network");
    if (job.controller.signal.aborted) {
      status = "stopped";
      completion = job.received > 0 ? "partial" : "unknown";
    } else if (networkFailureWithoutData) {
      status = "failed";
      completion = "unknown";
    } else if (job.lastError && job.received === 0) {
      status = "failed";
      completion = "unknown";
    } else if (job.completion === "partial" || job.reasons.length > 0) {
      status = "partial";
      completion = "partial";
    } else {
      status = "completed";
      completion = "complete";
    }
    job.terminal = true;
    job.completion = completion;
    job.status = status;
    this.emitState(job, status);
    // The terminal state is emitted only after the collection is final; a paired
    // viewChanged with the same revision lets the UI refresh without sleeping or
    // racing the "completed but table not updated" window.
    this.deps.emit(
      this.baseEvent(job, "viewChanged", {
        terminal: true,
        status,
        received: job.received,
        unique: job.collection.total,
      }),
    );
    void this.deps.sessions.close(job.id).catch(() => undefined);
  }

  private setStatus(job: JobRuntime, status: JobStatus): void {
    if (job.terminal) return;
    job.status = status;
    this.emitState(job, status);
  }

  private addReason(job: JobRuntime, reason: ReasonDto): void {
    const key = `${reason.code}|${reason.indexId ?? ""}|${reason.page ?? ""}`;
    const existing = job.reasons.find(
      (item) => `${item.code}|${item.indexId ?? ""}|${item.page ?? ""}` === key,
    );
    if (existing) {
      existing.count = (existing.count ?? 0) + (reason.count ?? 0);
      if (reason.message) existing.message = reason.message;
    } else {
      job.reasons.push({ ...reason });
    }
    this.emitReason(job, reason);
  }

  private baseEvent(job: JobRuntime, kind: JobEventDto["kind"], payload: Record<string, unknown>): JobEventDto {
    job.seq += 1;
    return {
      schemaVersion: SCHEMA_VERSION,
      jobId: job.id,
      source: job.source,
      seq: job.seq,
      revision: job.collection.revision,
      kind,
      payload,
    };
  }

  private emitState(job: JobRuntime, status: JobStatus): void {
    this.deps.emit(
      this.baseEvent(job, "state", {
        status,
        received: job.received,
        unique: job.collection.total,
        completion: job.completion,
      }),
    );
  }

  private emitProgress(job: JobRuntime, payload: Record<string, unknown>): void {
    this.deps.emit(
      this.baseEvent(job, "progress", {
        ...payload,
        received: job.received,
        unique: job.collection.total,
      }),
    );
    this.deps.emit(this.baseEvent(job, "viewChanged", { unique: job.collection.total }));
  }

  private emitReason(job: JobRuntime, reason: ReasonDto): void {
    this.deps.emit(this.baseEvent(job, "reason", { reason: { ...reason } }));
  }
}

export type { FrozenJobConfig, FilterSpec, SortSpec, RangeSpec, ProxySpec };
