/** Internal archive record plus the five-field export/display projection. */

import { EXPORT_FIELDS, type ExportField, type RowView, type SourceId } from "../contracts/types";
import { isInterestingUrl } from "./matching";

export interface RawArchiveRecord {
  url: string;
  statusCode: string;
  length: string;
  fileType: string;
  timestamp: string;
  rawTimestamp: string;
  source: SourceId;
  indexId?: string;
}

export interface ArchiveRecord extends RawArchiveRecord {
  rowId: string;
}

export function formatTimestamp(raw: string): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 8) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  return raw;
}

export function makeRecord(raw: RawArchiveRecord, rowNumber: number): ArchiveRecord {
  return {
    url: raw.url ?? "",
    statusCode: raw.statusCode ?? "",
    length: raw.length ?? "",
    fileType: raw.fileType ?? "",
    timestamp: raw.timestamp ?? "",
    rawTimestamp: raw.rawTimestamp ?? "",
    source: raw.source,
    indexId: raw.indexId,
    rowId: `r${rowNumber}`,
  };
}

export function toRowView(record: ArchiveRecord): RowView {
  return {
    rowId: record.rowId,
    timestamp: record.timestamp,
    statusCode: record.statusCode,
    length: record.length,
    fileType: record.fileType,
    url: record.url,
    interesting: isInterestingUrl(record.url),
  };
}

export function toExportRow(record: ArchiveRecord): Record<ExportField, string> {
  return {
    timestamp: record.timestamp,
    status_code: record.statusCode,
    length: record.length,
    file_type: record.fileType,
    url: record.url,
  };
}

export function exportHeader(): string {
  return EXPORT_FIELDS.join(",");
}

export function numericValue(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function exportExpression(record: ArchiveRecord, field: ExportField): string {
  return toExportRow(record)[field];
}
