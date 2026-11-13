import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArchiveRecord, JobEvent, Source } from "./contracts.ts";
import { readFixtureJson } from "./fixtures.ts";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function makeRecord(input: Partial<ArchiveRecord> & { url: string }): ArchiveRecord {
  return {
    url: input.url,
    statusCode: input.statusCode ?? "200",
    length: input.length ?? "100",
    fileType: input.fileType ?? "text/html",
    timestamp: input.timestamp ?? "2024-01-02",
    source: (input.source ?? "wayback") as Source,
    rawTimestamp: input.rawTimestamp ?? "20240102030405",
    indexId: input.indexId ?? "",
    rowId: input.rowId ?? "",
  };
}

/** Records used by the original five-field JSON sample. */
export function baselineJsonRecords(): ArchiveRecord[] {
  return [
    makeRecord({
      url: "https://example.com/a,b\n第二行",
      statusCode: "200",
      length: "512",
      fileType: "text/html",
      timestamp: "2024-01-02",
    }),
    makeRecord({
      url: "https://example.com/中文",
      statusCode: "404",
      length: "0",
      fileType: "application/json",
      timestamp: "2024-05-06",
    }),
  ];
}

/** Records used by the original five-field CSV sample (backend attachment). */
export function baselineCsvRecords(): ArchiveRecord[] {
  return [
    makeRecord({
      url: "https://example.com/a",
      statusCode: "200",
      length: "123",
      fileType: "text/html",
      timestamp: "2024-01-02",
    }),
    makeRecord({
      url: "https://example.com/路径/b?x=1,2",
      statusCode: "404",
      length: "0",
      fileType: "text/css",
      timestamp: "2023-12-31",
    }),
    makeRecord({
      url: 'https://example.com/quote"inside',
      statusCode: "",
      length: "",
      fileType: "unknown",
      timestamp: "",
    }),
  ];
}

export interface ClockFixture {
  instances: { clockUtc: string; purpose: string }[];
}

export function fixedClock(purpose: string): string {
  const fixture = readFixtureJson<ClockFixture>("clock/fixed-clocks.json");
  const found = fixture.instances.find((instance) => instance.purpose.startsWith(purpose));
  if (!found) throw new Error(`fixed clock not found: ${purpose}`);
  return found.clockUtc;
}

export class RecordingSink {
  events: JobEvent[] = [];
  errors: Error[] = [];
  deliver(event: JobEvent): void {
    try {
      this.events.push(event);
    } catch (error) {
      this.errors.push(error as Error);
    }
  }
  countFor(jobId: number): number {
    return this.events.filter((event) => event.jobId === jobId).length;
  }
}

export class TempDir {
  readonly path: string;
  constructor(prefix = "archrecon-acceptance-") {
    this.path = mkdtempSync(path.join(tmpdir(), prefix));
  }
  file(name: string): string {
    return path.join(this.path, name);
  }
  read(name: string): Buffer {
    return readFileSync(this.file(name));
  }
  dispose(): void {
    rmSync(this.path, { recursive: true, force: true });
  }
}

const TERMINAL = new Set(["completed", "partial", "failed", "stopped"]);

export async function waitForTerminal(
  iut: { getStatus(jobId: number): string | undefined },
  jobId: number,
  timeoutMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = iut.getStatus(jobId);
    if (status && TERMINAL.has(status)) return status;
    await sleep(5);
  }
  throw new Error(`job ${jobId} did not reach a terminal state; last=${iut.getStatus(jobId)}`);
}

