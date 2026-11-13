/** Ports used by the application layer; adapters live in main/adapters. */

import type { ProxySpec, ProxySnapshot, ReasonDto, SourceId } from "../contracts/types";
import type { RawArchiveRecord } from "../domain/record";
import type { CcIndexMeta } from "../domain/time";

export interface HttpResponseLike {
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  /** Present when the transport did not follow a redirect (manual mode). */
  location?: string;
}

export type Transport = (
  url: string,
  init?: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    onRedirect?: (targetUrl: string) => boolean;
  },
) => Promise<HttpResponseLike>;

export interface RequestOptions {
  signal: AbortSignal;
  timeoutMs: number;
  transport: Transport;
  /** Maximum accepted response size in bytes (bounded resource policy). */
  maxResponseBytes?: number;
  /** Optional per-hop redirect validator; false aborts the request. */
  validateRedirect?: (targetUrl: string) => boolean;
}

export interface JobLimits {
  maxResponseBytes: number;
}

export interface PageResult {
  records: RawArchiveRecord[];
  hasMore: boolean;
  parseSkipped: number;
  reasons: ReasonDto[];
}

export interface CommonCrawlPort {
  fetchIndexes(options: RequestOptions): Promise<{ metas: CcIndexMeta[]; invalidCount: number }>;
  pageCount(index: CcIndexMeta, host: string, options: RequestOptions): Promise<number>;
  queryPage(
    index: CcIndexMeta,
    host: string,
    page: number,
    pageSize: number,
    options: RequestOptions,
  ): Promise<PageResult>;
}

export interface WaybackPort {
  queryPage(host: string, page: number, pageSize: number, options: RequestOptions): Promise<PageResult>;
}

export interface JobSession {
  transport: Transport;
  proxy: ProxySnapshot;
}

export interface SessionFactory {
  /** Creates an isolated session, applies the proxy and never falls back to direct. */
  create(jobId: number, proxy: ProxySpec, limits?: JobLimits): Promise<JobSession>;
  close(jobId: number): Promise<void>;
}

export interface JobDeps {
  clock: () => Date;
  wayback: WaybackPort;
  commoncrawl: CommonCrawlPort;
  sessions: SessionFactory;
  emit: (event: import("../contracts/types").JobEventDto) => void;
  budgets?: Partial<import("./budgets").JobBudgets>;
  source?: SourceId;
}
