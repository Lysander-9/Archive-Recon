/** Five-field CSV/JSON export with temp-file + replace semantics. */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EXPORT_FIELDS, type ExportField } from "../contracts/types";
import { AppError } from "../application/errors";

export type ExportRow = Record<ExportField, string>;

const SAFE_EXPORT_CODES = new Set([
  "EACCES", "EPERM", "ENOENT", "ENOSPC", "EROFS", "EEXIST", "EISDIR",
  "ENOTDIR", "EBUSY", "EMFILE", "ENFILE", "EXDEV", "EINVAL", "EIO",
]);

function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function csvBuffer(rows: ExportRow[]): Buffer {
  const lines: string[] = [EXPORT_FIELDS.join(",")];
  for (const row of rows) {
    lines.push(EXPORT_FIELDS.map((field) => escapeCsvField(row[field] ?? "")).join(","));
  }
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

export function jsonBuffer(rows: ExportRow[]): Buffer {
  const ordered = rows.map((row) => {
    const value: Record<string, string> = {};
    for (const field of EXPORT_FIELDS) value[field] = row[field] ?? "";
    return value;
  });
  return Buffer.from(JSON.stringify(ordered, null, 2), "utf8");
}

export async function writeExport(
  rows: ExportRow[],
  format: "csv" | "json",
  targetPath: string,
): Promise<number> {
  const directory = path.dirname(path.resolve(targetPath));
  const suffix = format === "csv" ? ".csv" : ".json";
  const tempPath = path.join(directory, `.archrecon-${randomUUID()}${suffix}`);
  const payload = format === "csv" ? csvBuffer(rows) : jsonBuffer(rows);
  try {
    await fs.writeFile(tempPath, payload);
    await fs.rename(tempPath, targetPath);
    return rows.length;
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // ignore cleanup failure
    }
    // Filesystem text, paths and causes are untrusted diagnostic data. Publish
    // only a fixed template and an exact known code, never promote raw text to
    // a trusted AppError (including errors with throwing code accessors).
    let code: unknown;
    try { code = (error as { code?: unknown } | null)?.code; } catch { /* no safe code */ }
    const safeCode = typeof code === "string" && SAFE_EXPORT_CODES.has(code) ? `（${code}）` : "";
    throw new AppError("EXPORT", `导出失败${safeCode}，请检查保存位置、可用空间和写入权限后重试`);
  }
}

export function exportFileName(source: string, format: "csv" | "json"): string {
  return `${source}_results.${format}`;
}
