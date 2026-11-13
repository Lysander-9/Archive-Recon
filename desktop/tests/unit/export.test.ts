import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

import { AppError } from "../../src/application/errors";
import { csvBuffer, jsonBuffer, writeExport } from "../../src/main/export";

const rows = [
  {
    timestamp: "2024-01-02",
    status_code: "200",
    length: "10",
    file_type: "text/html",
    url: "https://example.com/a",
  },
  {
    timestamp: "2024-01-03",
    status_code: "404",
    length: "0",
    file_type: "text/plain",
    url: "https://example.com/路径,b?x=1",
  },
];

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "archive-export-"));
}

test.describe("five-field export", () => {
  test("CSV is BOM + exact header + CRLF with correct escaping", () => {
    const buffer = csvBuffer(rows);
    const text = buffer.toString("utf8");
    expect(buffer.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(text.slice(1).startsWith("timestamp,status_code,length,file_type,url\r\n")).toBe(true);
    expect(text).toContain('"https://example.com/路径,b?x=1"');
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text).not.toContain("source");
  });

  test("CSV quotes quotes and newlines", () => {
    const buffer = csvBuffer([
      {
        timestamp: "2024-01-02",
        status_code: "200",
        length: "1",
        file_type: "text/html",
        url: 'https://example.com/q"uote\nline',
      },
    ]);
    const text = buffer.toString("utf8");
    expect(text).toContain('"https://example.com/q""uote\nline"');
  });

  test("JSON keeps the exact five keys and unicode", () => {
    const parsed = JSON.parse(jsonBuffer(rows).toString("utf8")) as Array<Record<string, string>>;
    expect(parsed).toHaveLength(2);
    expect(Object.keys(parsed[0])).toEqual([
      "timestamp",
      "status_code",
      "length",
      "file_type",
      "url",
    ]);
    expect(parsed[1].url).toBe("https://example.com/路径,b?x=1");
  });

  test("writeExport writes a file and reports the row count", async () => {
    const directory = await tempDir();
    const target = path.join(directory, "results.csv");

    const count = await writeExport(rows, "csv", target);

    expect(count).toBe(2);
    const written = await fs.readFile(target);
    expect(written.equals(csvBuffer(rows))).toBe(true);
  });

  test("failed write raises EXPORT and leaves no temp file", async () => {
    const directory = await tempDir();
    const target = path.join(directory, "as-directory");
    await fs.mkdir(target);

    await expect(writeExport(rows, "csv", target)).rejects.toBeInstanceOf(AppError);
    const entries = await fs.readdir(directory);
    expect(entries.filter((name) => name.startsWith(".archrecon-"))).toEqual([]);
  });
});
