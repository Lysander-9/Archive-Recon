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

  test("parses official from/to timestamps and flags unknown metadata", () => {
    const meta = parseCcIndex({
      id: "CC-MAIN-2025-38",
      "cdx-api": "https://index.commoncrawl.org/CC-MAIN-2025-38-index",
      from: "20250801000000",
      to: "20250930235959",
    });
    expect(meta).not.toBeNull();
    expect(meta?.unknown).toBe(false);
    expect(meta?.fromMs).toBe(Date.UTC(2025, 7, 1));

    const broken = parseCcIndex({
      id: "CC-MAIN-TEST",
      "cdx-api": "https://example.invalid/index",
      from: "not-a-date",
      to: "20240101000000",
    });
    expect(broken?.unknown).toBe(true);
    expect(parseOfficialTimestamp("20240101000000")).toBe(Date.UTC(2024, 0, 1));
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
