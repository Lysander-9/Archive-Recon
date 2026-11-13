import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readFixtureJson } from "./fixtures.ts";

export interface ClockFixture {
  instances: { clockUtc: string; purpose: string }[];
}

export function fixedClock(purpose: string): string {
  const fixture = readFixtureJson<ClockFixture>("clock/fixed-clocks.json");
  const found = fixture.instances.find((instance) => instance.purpose.startsWith(purpose));
  if (!found) throw new Error(`fixed clock not found: ${purpose}`);
  return found.clockUtc;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Records for the original five-field CSV sample (backend attachment). */
export function baselineCsvRecords() {
  return [
    {
      url: "https://example.com/a",
      statusCode: "200",
      length: "123",
      fileType: "text/html",
      timestamp: "2024-01-02",
      rawTimestamp: "20240102030405",
      source: "wayback" as const,
    },
    {
      url: "https://example.com/路径/b?x=1,2",
      statusCode: "404",
      length: "0",
      fileType: "text/css",
      timestamp: "2023-12-31",
      rawTimestamp: "20231231000000",
      source: "wayback" as const,
    },
    {
      url: 'https://example.com/quote"inside',
      statusCode: "",
      length: "",
      fileType: "unknown",
      timestamp: "",
      rawTimestamp: "",
      source: "wayback" as const,
    },
  ];
}

/** Records used by the original five-field JSON sample. */
export function baselineJsonRecords() {
  return [
    {
      url: "https://example.com/a,b\n第二行",
      statusCode: "200",
      length: "512",
      fileType: "text/html",
      timestamp: "2024-01-02",
      rawTimestamp: "20240102030405",
      source: "wayback" as const,
    },
    {
      url: "https://example.com/中文",
      statusCode: "404",
      length: "0",
      fileType: "application/json",
      timestamp: "2024-05-06",
      rawTimestamp: "20240506070809",
      source: "wayback" as const,
    },
  ];
}

export function exportRows(records: ReturnType<typeof baselineCsvRecords>) {
  return records.map((record) => ({
    timestamp: record.timestamp,
    status_code: record.statusCode,
    length: record.length,
    file_type: record.fileType,
    url: record.url,
  }));
}
