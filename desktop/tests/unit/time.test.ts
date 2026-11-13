import { expect, test } from "@playwright/test";

import {
  parseCcIndex,
  parseOfficialTimestamp,
  resolveRange,
  selectIndexes,
  utcMonthWindow,
} from "../../src/domain/time";

const clock = new Date("2025-09-15T12:00:00Z");

test.describe("UTC month windows (T3)", () => {
  test("recent N months includes the current month", () => {
    const selection = resolveRange({ kind: "recent", months: 3 }, clock);
    expect(selection.window?.fromUtc).toBe("2025-07-01T00:00:00.000Z");
    expect(selection.window?.toUtc).toBe("2025-10-01T00:00:00.000Z");
  });

  test("recent window crosses the year boundary", () => {
    const selection = resolveRange({ kind: "recent", months: 3 }, new Date("2025-01-10T00:00:00Z"));
    expect(selection.window?.fromUtc).toBe("2024-11-01T00:00:00.000Z");
    expect(selection.window?.toUtc).toBe("2025-02-01T00:00:00.000Z");
  });

  test("specific month is a UTC [start, next-month) window", () => {
    const window = utcMonthWindow(2024, 12);
    expect(window.fromUtc).toBe("2024-12-01T00:00:00.000Z");
    expect(window.toUtc).toBe("2025-01-01T00:00:00.000Z");
  });

  test("all time has no window", () => {
    expect(resolveRange({ kind: "all" }, clock).window).toBeNull();
  });
});

test.describe("official Common Crawl interval selection (T3)", () => {
  const window = resolveRange({ kind: "recent", months: 3 }, new Date("2025-09-15T00:00:00Z"));

  test("no-timezone official timestamps are interpreted strictly as UTC", () => {
    expect(parseOfficialTimestamp("2024-10-03T09:40:20")).toBe(Date.UTC(2024, 9, 3, 9, 40, 20));
    expect(parseOfficialTimestamp("2024-10-03 09:40:20")).toBe(Date.UTC(2024, 9, 3, 9, 40, 20));
    expect(parseOfficialTimestamp("20241003094020")).toBe(Date.UTC(2024, 9, 3, 9, 40, 20));
    expect(parseOfficialTimestamp("2024-10-03")).toBe(Date.UTC(2024, 9, 3));
  });

  test("explicit offsets are honoured and invalid dates are rejected", () => {
    expect(parseOfficialTimestamp("2024-10-03T09:40:20Z")).toBe(Date.UTC(2024, 9, 3, 9, 40, 20));
    expect(parseOfficialTimestamp("2024-10-03T09:40:20+08:00")).toBe(Date.UTC(2024, 9, 3, 1, 40, 20));
    expect(parseOfficialTimestamp("2024-10-03T09:40:20-05:00")).toBe(Date.UTC(2024, 9, 3, 14, 40, 20));
    expect(parseOfficialTimestamp("2024-02-30T00:00:00")).toBeNull();
    expect(parseOfficialTimestamp("2024-13-01T00:00:00")).toBeNull();
    expect(parseOfficialTimestamp("2024-10-03T25:00:00")).toBeNull();
    expect(parseOfficialTimestamp("not-a-date")).toBeNull();
  });

  test("cross-month metadata is selected for each intersecting UTC month", () => {
    const crossMonth = parseCcIndex({
      id: "CC-MAIN-2025-18",
      "cdx-api": "https://index.commoncrawl.org/CC-MAIN-2025-18-index",
      from: "2025-04-01T00:00:00",
      to: "2025-05-01T01:05:29",
    })!;
    const mayWindow = resolveRange({ kind: "month", year: 2025, month: 5 }, clock);
    const aprilWindow = resolveRange({ kind: "month", year: 2025, month: 4 }, clock);

    expect(selectIndexes([crossMonth], mayWindow).indexes.map((item) => item.id)).toEqual([
      "CC-MAIN-2025-18",
    ]);
    expect(selectIndexes([crossMonth], aprilWindow).indexes.map((item) => item.id)).toEqual([
      "CC-MAIN-2025-18",
    ]);
  });

  test("a UTC boundary index is not pulled into the previous month", () => {
    const boundary = parseCcIndex({
      id: "CC-MAIN-BOUNDARY",
      "cdx-api": "https://index.commoncrawl.org/CC-MAIN-BOUNDARY-index",
      from: "2024-11-01T00:00:00",
      to: "2024-11-02T00:00:00",
    })!;
    const october = resolveRange({ kind: "month", year: 2024, month: 10 }, clock);

    expect(selectIndexes([boundary], october).indexes).toEqual([]);
  });

  test("malformed official timestamps mark an index as unknown", () => {
    const inverted = parseCcIndex({
      id: "CC-MAIN-INVERTED",
      "cdx-api": "https://index.commoncrawl.org/CC-MAIN-INVERTED-index",
      from: "2024-12-01T00:00:00",
      to: "2024-11-01T00:00:00",
    })!;
    expect(inverted.unknown).toBe(true);
  });

  test("selects by interval intersection, not by id or name", () => {
    const overlapping = parseCcIndex({
      id: "CC-MAIN-2025-38",
      "cdx-api": "https://index.commoncrawl.org/CC-MAIN-2025-38-index",
      from: "20250801000000",
      to: "20250930235959",
    })!;
    const stale = parseCcIndex({
      id: "CC-MAIN-2024-38",
      "cdx-api": "https://index.commoncrawl.org/CC-MAIN-2024-38-index",
      from: "20240101000000",
      to: "20240201000000",
    })!;
    const unknown = parseCcIndex({
      id: "CC-MAIN-2099-01",
      "cdx-api": "https://index.commoncrawl.org/CC-MAIN-2099-01-index",
    })!;

    const selected = selectIndexes([overlapping, stale, unknown], window);

    expect(selected.indexes.map((item) => item.id)).toEqual(["CC-MAIN-2025-38"]);
    expect(selected.unknownExcluded).toBe(1);
  });

  test("all-time keeps unknown metadata but still reports it", () => {
    const unknown = parseCcIndex({
      id: "CC-MAIN-2099-01",
      "cdx-api": "https://index.commoncrawl.org/CC-MAIN-2099-01-index",
    })!;
    const selected = selectIndexes([unknown], resolveRange({ kind: "all" }, clock));
    expect(selected.indexes).toHaveLength(1);
    expect(selected.unknownIncluded).toBe(true);
  });
});
