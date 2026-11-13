import { expect, test } from "@playwright/test";

import { ResultCollection } from "../../src/domain/results";
import { EMPTY_FILTER } from "../../src/contracts/types";
import { rawRecord } from "../support/builders";

function collection(records = [
  rawRecord("https://example.com/a", { statusCode: "200", timestamp: "2024-01-02" }),
  rawRecord("https://example.com/b", { statusCode: "404", timestamp: "2024-01-01" }),
]) {
  return new ResultCollection(records);
}

test.describe("result collection (T4/R1)", () => {
  test("dedupes same batch and cross batch keeping the first record", async () => {
    const results = new ResultCollection();
    const first = results.append([
      rawRecord("https://example.com/a", { timestamp: "2024-01-01" }),
      rawRecord("https://example.com/a", { timestamp: "2025-01-01" }),
      rawRecord("https://example.com/b"),
    ]);
    expect(first.added).toBe(2);
    expect(first.batchDuplicates).toBe(1);

    const second = results.append([
      rawRecord("https://example.com/a", { timestamp: "2026-01-01" }),
      rawRecord("https://example.com/c"),
    ]);
    expect(second.added).toBe(1);
    expect(second.knownDuplicates).toBe(1);
    expect(results.rawRecords().map((record) => record.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
    expect(results.rawRecords()[0].timestamp).toBe("2024-01-01");
  });

  test("keeps the filter and sort when appending without touching raw order", () => {
    const results = collection();
    results.setFilter({ ...EMPTY_FILTER, status: "200" });
    results.setSort({ key: "timestamp", reverse: false });

    results.append([
      rawRecord("https://example.com/c", { statusCode: "200", timestamp: "2024-02-01" }),
      rawRecord("https://example.com/d", { statusCode: "404", timestamp: "2024-03-01" }),
    ]);

    expect(results.matched()).toBe(2);
    expect(results.view().map((record) => record.url)).toEqual([
      "https://example.com/a",
      "https://example.com/c",
    ]);
    expect(results.rawRecords().map((record) => record.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
      "https://example.com/d",
    ]);
  });

  test("sorting is stable and never reorders the raw collection", () => {
    const results = collection();
    results.setSort({ key: "status_code", reverse: false });

    expect(results.view().map((record) => record.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    results.setSort({ key: "status_code", reverse: true });
    expect(results.view().map((record) => record.url)).toEqual([
      "https://example.com/b",
      "https://example.com/a",
    ]);
    expect(results.rawRecords().map((record) => record.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  test("clearing filters restores the full match and invalidates the view cache", () => {
    const results = collection();
    results.setFilter({ ...EMPTY_FILTER, status: "200" });
    expect(results.matched()).toBe(1);

    results.clearFilter();
    expect(results.matched()).toBe(2);
  });

  test("export snapshot uses filtered and sorted rows only, five fields", () => {
    const results = collection();
    results.setFilter({ ...EMPTY_FILTER, status: "200" });

    const snapshot = results.snapshot();

    expect(snapshot).toHaveLength(1);
    expect(Object.keys(snapshot[0])).toEqual([
      "timestamp",
      "status_code",
      "length",
      "file_type",
      "url",
    ]);
  });

  test("page count is zero for empty matches and clamps page indexes", () => {
    const results = collection();
    results.setFilter({ ...EMPTY_FILTER, status: "999" });

    expect(results.page(0, 50).pageCount).toBe(0);
    expect(results.page(0, 50).rows).toEqual([]);

    results.clearFilter();
    expect(results.page(99, 1).pageIndex).toBe(1);
  });

  test("revision advances on reset/append and stays stable for filter changes", () => {
    const results = collection();
    const firstRevision = results.revision;
    results.setFilter({ ...EMPTY_FILTER, status: "200" });
    expect(results.revision).toBe(firstRevision);
    results.append([rawRecord("https://example.com/new")]);
    expect(results.revision).toBeGreaterThan(firstRevision);
  });
});
