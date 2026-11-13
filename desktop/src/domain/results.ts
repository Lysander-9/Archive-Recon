/** Unique-URL result collection: raw order preserved; filter/sort are derived views. */

import {
  EMPTY_FILTER,
  type ExportField,
  type FilterSpec,
  type RowView,
  type SortSpec,
} from "../contracts/types";
import { applyFilter, sortRecords } from "./results-filter";
import { toExportRow, toRowView, type ArchiveRecord } from "./record";

export type NewRecord = Omit<ArchiveRecord, "rowId">;

export interface AppendOutcome {
  added: number;
  duplicates: number;
  batchDuplicates: number;
  knownDuplicates: number;
  total: number;
}

interface ViewCache {
  filter: FilterSpec;
  sort: SortSpec;
  records: ArchiveRecord[];
}

export class ResultCollection {
  private records: ArchiveRecord[] = [];
  private urls = new Set<string>();
  private filter: FilterSpec = { ...EMPTY_FILTER };
  private sort: SortSpec = { key: null, reverse: false };
  private cache: ViewCache | null = null;
  private dataRevision = 0;
  private rowCounter = 0;

  constructor(records: Iterable<NewRecord> = []) {
    if (records) this.reset(records);
  }

  get revision(): number {
    return this.dataRevision;
  }

  get total(): number {
    return this.records.length;
  }

  get filterSpec(): FilterSpec {
    return { ...this.filter };
  }

  get sortSpec(): SortSpec {
    return { ...this.sort };
  }

  reset(records: Iterable<NewRecord> = []): AppendOutcome {
    this.records = [];
    this.urls = new Set();
    this.rowCounter = 0;
    const outcome = this.append(records);
    this.invalidate();
    return outcome;
  }

  append(records: Iterable<NewRecord>): AppendOutcome {
    let added = 0;
    let batchDuplicates = 0;
    let knownDuplicates = 0;
    const batchKeys = new Set<string>();
    for (const record of records) {
      const key = record.url;
      if (key) {
        if (batchKeys.has(key)) {
          batchDuplicates += 1;
          continue;
        }
        if (this.urls.has(key)) {
          knownDuplicates += 1;
          continue;
        }
        batchKeys.add(key);
        this.urls.add(key);
      }
      this.rowCounter += 1;
      this.records.push({ ...record, rowId: `r${this.rowCounter}` });
      added += 1;
    }
    if (added > 0) this.invalidate();
    return {
      added,
      duplicates: batchDuplicates + knownDuplicates,
      batchDuplicates,
      knownDuplicates,
      total: this.records.length,
    };
  }

  setFilter(spec: FilterSpec): void {
    this.filter = { ...spec };
    this.cache = null;
  }

  clearFilter(): void {
    this.filter = { ...EMPTY_FILTER };
    this.cache = null;
  }

  setSort(spec: SortSpec): void {
    this.sort = { key: spec.key, reverse: spec.reverse };
    this.cache = null;
  }

  clearSort(): void {
    this.sort = { key: null, reverse: false };
    this.cache = null;
  }

  /** Clear all caches unconditionally (R1: even without data changes). */
  invalidate(): void {
    this.cache = null;
    this.dataRevision += 1;
  }

  rawRecords(): ArchiveRecord[] {
    return this.records.slice();
  }

  /** Whether this exact URL was already accepted (used by the record budget). */
  hasUrl(url: string): boolean {
    return Boolean(url) && this.urls.has(url);
  }

  view(): ArchiveRecord[] {
    if (this.cache) return this.cache.records;
    const filtered = applyFilter(this.records, this.filter);
    const sorted = sortRecords(filtered, this.sort);
    this.cache = {
      filter: { ...this.filter },
      sort: { key: this.sort.key, reverse: this.sort.reverse },
      records: sorted,
    };
    return sorted;
  }

  matched(): number {
    return this.view().length;
  }

  page(pageIndex: number, pageSize: number): { rows: RowView[]; pageIndex: number; pageCount: number } {
    const view = this.view();
    const matched = view.length;
    const pageCount = matched === 0 ? 0 : Math.ceil(matched / Math.max(1, pageSize));
    const safeSize = Math.max(1, pageSize);
    const lastIndex = pageCount === 0 ? 0 : pageCount - 1;
    const clamped = Math.min(Math.max(0, pageIndex), lastIndex);
    const start = clamped * safeSize;
    return {
      rows: view.slice(start, start + safeSize).map(toRowView),
      pageIndex: clamped,
      pageCount,
    };
  }

  snapshot(): Array<Record<ExportField, string>> {
    return this.view().map(toExportRow);
  }

  recordsByIds(rowIds: string[]): ArchiveRecord[] {
    const wanted = new Set(rowIds);
    return this.view().filter((record) => wanted.has(record.rowId));
  }
}
