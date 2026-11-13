/**
 * In-memory fixture transport. No sockets, no loopback server, no external
 * targets. Every call records the proxy configuration it was made with so the
 * suite can prove that a failed fixed proxy never falls back to direct.
 */

import { readFixtureText } from "./fixtures.ts";
import {
  ProxyFailure,
  type Transport, type TransportCall, type TransportRequest,
  type TransportResponse,
} from "./reference-iut.ts";

export type CollInfoVariant = "selected" | "full" | "abnormal";
export type WaybackFirstPage = "short" | "full" | "empty";

export interface FixtureTransportOptions {
  collinfo?: CollInfoVariant;
  pageCount?: 1 | 2 | 3 | 7;
  waybackFirstPage?: WaybackFirstPage;
  delay?: {
    waybackPage?: number;
    ccPage?: number;
    ccCollinfo?: number;
    ccPageCount?: number;
  };
  proxyFailure?: boolean;
  ccRepeatPage0?: boolean;
}

export interface FixtureTransport extends Transport {
  calls: TransportCall[];
  directCalls: TransportCall[];
  waitForCall(predicate: (call: TransportCall) => boolean, timeoutMs?: number): Promise<TransportCall>;
  callsOfKind(kind: string): TransportCall[];
}

const COLLINFO_FIXTURES: Record<CollInfoVariant, string> = {
  selected: "metadata/collinfo-selected.json",
  full: "metadata/collinfo-2026-11-13.json",
  abnormal: "metadata/collinfo-abnormal.json",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFixtureTransport(options: FixtureTransportOptions = {}): FixtureTransport {
  const calls: TransportCall[] = [];
  const pageCount = options.pageCount ?? 1;
  const firstPage = options.waybackFirstPage ?? "short";

  const transport: FixtureTransport = {
    calls,
    get directCalls() {
      return calls.filter((call) => call.proxy.mode === "direct");
    },
    callsOfKind(kind) {
      return calls.filter((call) => call.kind === kind);
    },
    async waitForCall(predicate, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = calls.find(predicate);
        if (found) return found;
        await sleep(5);
      }
      throw new Error("timed out waiting for transport call");
    },
    async fetchText(request: TransportRequest): Promise<TransportResponse> {
      calls.push({
        source: request.source,
        kind: request.kind,
        url: request.url,
        jobId: request.jobId,
        proxy: { ...request.proxy },
      });

      if (options.proxyFailure && request.proxy.mode === "fixed") {
        throw new ProxyFailure("synthetic proxy connect refused");
      }

      if (request.kind === "wayback-page") {
        const delay = options.delay?.waybackPage;
        if (delay !== undefined && request.page === delay) await sleep(30);
        const page = request.page ?? 0;
        if (page === 0) {
          if (firstPage === "full") return { status: 200, text: readFixtureText("sources/wayback_full_page.json") };
          if (firstPage === "empty") return { status: 200, text: readFixtureText("sources/wayback_empty.json") };
          return { status: 200, text: readFixtureText("sources/wayback_page_0.json") };
        }
        if (page === 1) return { status: 200, text: readFixtureText("sources/wayback_page_1.json") };
        return { status: 200, text: readFixtureText("sources/wayback_empty.json") };
      }

      if (request.kind === "cc-collinfo") {
        const delay = options.delay?.ccCollinfo;
        if (delay !== undefined) await sleep(30);
        return {
          status: 200,
          text: readFixtureText(COLLINFO_FIXTURES[options.collinfo ?? "selected"]),
        };
      }

      if (request.kind === "cc-page-count") {
        const delay = options.delay?.ccPageCount;
        if (delay !== undefined) await sleep(30);
        const file = pageCount === 1 ? "cc_page_count_one.json"
          : pageCount === 2 ? "cc_page_count_two.json"
            : "cc_page_count.json";
        return { status: 200, text: readFixtureText("sources", file) };
      }

      if (request.kind === "cc-page") {
        const delay = options.delay?.ccPage;
        if (delay !== undefined && request.page === delay) await sleep(30);
        const page = request.page ?? 0;
        if (page === 0) return { status: 200, text: readFixtureText("sources/cc_page_0.ndjson") };
        if (page === 1) return { status: 200, text: readFixtureText("sources/cc_page_1.ndjson") };
        if (options.ccRepeatPage0) return { status: 200, text: readFixtureText("sources/cc_page_0.ndjson") };
        return { status: 200, text: "" };
      }

      throw new Error(`unknown fixture transport kind: ${request.kind}`);
    },
  };

  return transport;
}

export { ProxyFailure };
