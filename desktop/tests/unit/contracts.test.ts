import { expect, test } from "@playwright/test";

import {
  validateCancel,
  validateCopy,
  validateExport,
  validateGetView,
  validateStart,
} from "../../src/contracts/validate";

const baseStart = {
  target: "example.com",
  source: "wayback",
  range: { kind: "recent", months: 3 },
  proxy: { mode: "direct" },
};

test.describe("IPC runtime validation", () => {
  test("accepts a valid start request and rejects unknown sources", () => {
    expect(validateStart(baseStart).ok).toBe(true);
    const bad = validateStart({ ...baseStart, source: "bing" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("INVALID_INPUT");
  });

  test("rejects invalid ranges and proxies without touching the network layer", () => {
    expect(validateStart({ ...baseStart, range: { kind: "recent", months: 0 } }).ok).toBe(false);
    expect(validateStart({ ...baseStart, range: { kind: "month", year: 2024, month: 13 } }).ok).toBe(false);
    expect(validateStart({ ...baseStart, proxy: { mode: "fixed", server: "" } }).ok).toBe(false);
    expect(validateStart({ ...baseStart, proxy: { mode: "fixed", server: "127.0.0.1:7890" } }).ok).toBe(false);
  });

  test("view requests require a source-bound job and sane paging", () => {
    const valid = validateGetView({
      jobId: 1,
      source: "commoncrawl",
      filter: { status: "200" },
      sort: { key: "length", reverse: true },
      pageIndex: 0,
      pageSize: 50,
    });
    expect(valid.ok).toBe(true);

    expect(validateGetView({ jobId: 0, source: "wayback", pageIndex: 0, pageSize: 50 }).ok).toBe(false);
    expect(
      validateGetView({ jobId: 1, source: "wayback", pageIndex: -1, pageSize: 50 }).ok,
    ).toBe(false);
    expect(
      validateGetView({ jobId: 1, source: "wayback", pageIndex: 0, pageSize: 50, sort: { key: "source" } }).ok,
    ).toBe(false);
  });

  test("export requires the expected revision and a supported format", () => {
    const request = {
      jobId: 1,
      source: "wayback",
      expectedRevision: 3,
      filter: {},
      sort: { key: null, reverse: false },
      format: "csv",
    };
    expect(validateExport(request).ok).toBe(true);
    expect(validateExport({ ...request, expectedRevision: -1 }).ok).toBe(false);
    expect(validateExport({ ...request, format: "xlsx" }).ok).toBe(false);
  });

  test("cancel and copy reject unknown job sources and oversized selections", () => {
    expect(validateCancel({ jobId: 1, source: "wayback" }).ok).toBe(true);
    expect(validateCancel({ jobId: 1, source: "other" }).ok).toBe(false);
    expect(
      validateCopy({
        jobId: 1,
        source: "wayback",
        revision: 1,
        rowIds: ["r1", "r2"],
        mode: "url",
      }).ok,
    ).toBe(true);
    expect(
      validateCopy({
        jobId: 1,
        source: "wayback",
        revision: 1,
        rowIds: ["r1", 2],
        mode: "url",
      }).ok,
    ).toBe(false);
  });
});
