/** Pure filtering and stable sorting over archive records. */

import type { FilterSpec, SortKey, SortSpec } from "../contracts/types";
import { isInterestingUrl, matchDomainPatterns, splitTerms, stripDomainCountSuffix } from "./matching";
import { numericValue, type ArchiveRecord } from "./record";

function filterByStatus(records: ArchiveRecord[], raw: string): ArchiveRecord[] {
  const { includes, excludes } = splitTerms(raw);
  const includeSet = new Set(includes);
  const excludeSet = new Set(excludes);
  return records.filter((record) => {
    if (includeSet.size > 0 && !includeSet.has(record.statusCode)) return false;
    if (excludeSet.size > 0 && excludeSet.has(record.statusCode)) return false;
    return true;
  });
}

function filterBySubstring(
  records: ArchiveRecord[],
  raw: string,
  field: "fileType" | "url",
): ArchiveRecord[] {
  const { includes, excludes } = splitTerms(raw);
  const includeTerms = includes.map((item) => item.toLowerCase());
  const excludeTerms = excludes.map((item) => item.toLowerCase());
  return records.filter((record) => {
    const value = (record[field] || "").toLowerCase();
    if (includeTerms.length > 0 && !includeTerms.every((term) => value.includes(term))) {
      return false;
    }
    if (excludeTerms.some((term) => value.includes(term))) return false;
    return true;
  });
}

function filterByDomain(records: ArchiveRecord[], raw: string): ArchiveRecord[] {
  const { includes, excludes } = splitTerms(stripDomainCountSuffix(raw));
  if (includes.length === 0 && excludes.length === 0) return records;
  const includePatterns = includes.map((item) => item.toLowerCase());
  const excludePatterns = excludes.map((item) => item.toLowerCase());
  return records.filter((record) =>
    matchDomainPatterns(record.url, includePatterns, excludePatterns),
  );
}

export function isFilterActive(spec: FilterSpec | null | undefined): boolean {
  if (!spec) return false;
  return Boolean(
    spec.status.trim() ||
      spec.fileType.trim() ||
      spec.urlKeyword.trim() ||
      spec.domain.trim() ||
      spec.interestingOnly,
  );
}

export function applyFilter(records: ArchiveRecord[], spec: FilterSpec | null | undefined): ArchiveRecord[] {
  let filtered = records.slice();
  if (!isFilterActive(spec)) return filtered;
  const active = spec as FilterSpec;
  if (active.status.trim()) filtered = filterByStatus(filtered, active.status);
  if (active.fileType.trim()) filtered = filterBySubstring(filtered, active.fileType, "fileType");
  if (active.urlKeyword.trim()) filtered = filterBySubstring(filtered, active.urlKeyword, "url");
  if (active.domain.trim()) filtered = filterByDomain(filtered, active.domain);
  if (active.interestingOnly) filtered = filtered.filter((record) => isInterestingUrl(record.url));
  return filtered;
}

function sortValue(record: ArchiveRecord, key: SortKey): number | string {
  switch (key) {
    case "length":
      return numericValue(record.length);
    case "status_code":
      return numericValue(record.statusCode);
    case "timestamp":
      return record.timestamp.toLowerCase();
    case "file_type":
      return record.fileType.toLowerCase();
    case "url":
      return record.url.toLowerCase();
    default:
      return "";
  }
}

export function sortRecords(records: ArchiveRecord[], spec: SortSpec | null | undefined): ArchiveRecord[] {
  const result = records.slice();
  if (!spec || !spec.key) return result;
  const key = spec.key;
  const direction = spec.reverse ? -1 : 1;
  result.sort((left, right) => {
    const a = sortValue(left, key);
    const b = sortValue(right, key);
    if (a < b) return -1 * direction;
    if (a > b) return 1 * direction;
    return 0;
  });
  return result;
}
