/** Ports used by the application layer; adapters live in main/adapters. */

import type { ProxySpec, ProxySnapshot, ReasonDto, SourceId } from "../contracts/types";
import type { RawArchiveRecord } from "../domain/record";
import type { CcIndexMeta } from "../domain/time";

export interface HttpResponseLike {
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type Transport = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<HttpResponseLike>;

export interface RequestOptions {
  signal: AbortSignal;
  timeoutMs: number;
  transport: Transport;
}

export interface PageResult {
  records: RawArchiveRecord[];
  hasMore: boolean;
  parseSkipped: number;
  reasons: ReasonDto[];
}

export interface CommonCrawlPort {
  fetchIndexes(options: RequestOptions): Promise<{ metas: CcIndexMeta[] }>;
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
  create(jobId: number, proxy: ProxySpec): Promise<JobSession>;
  close(jobId: number): Promise<void>;
}

export interface JobDeps {
  clock: () => Date;
  wayback: WaybackPort;
  commoncrawl: CommonCrawlPort;
  sessions: SessionFactory;
  emit: (event: import("../contracts/types").JobEventDto) => void;
  waybackRequestTimeoutMs?: number;
  commonCrawlRequestTimeoutMs?: number;
  source?: SourceId;
}
