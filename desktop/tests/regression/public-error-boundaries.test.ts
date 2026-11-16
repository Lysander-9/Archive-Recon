import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { AppError } from "../../src/application/errors";
import { JobManager } from "../../src/application/job";
import { EMPTY_FILTER, type JobEventDto } from "../../src/contracts/types";
import { sanitizePublicText } from "../../src/application/sanitize";
import { writeExport } from "../../src/main/export";

const marker = "PUBLIC_BOUNDARY_SYNTHETIC_SECRET";
const json = JSON.stringify({ password: 'prefix", ' + marker });
const payloads = [
  json,
  `来源返回 HTTP 504：${json}`,
  JSON.stringify({ nested: [{ password: 'prefix\\", ' + marker }] }, null, 2),
  `password="prefix\\\", ${marker}"`,
  `诊断 {"password":"prefix\\\", ${marker}`,
];

for (const [index, payload] of payloads.entries()) {
  test(`structured diagnostic ${index} is opaque and sanitization is idempotent`, () => {
    const once = sanitizePublicText(payload);
    assert.ok(!once.includes(marker));
    assert.equal(sanitizePublicText(once), once);
    const error = new AppError("NETWORK", payload, {
      context: { httpStatus: 504, stage: "http", attempts: 3 },
    });
    assert.ok(!error.message.includes(marker));
    assert.ok(!JSON.stringify(error.toDto()).includes(marker));
    assert.equal(error.toDto().context?.httpStatus, 504);
    assert.equal(error.toDto().context?.stage, "http");
    assert.equal(error.toDto().context?.attempts, 3);
  });
}

test("escaped JSON cannot reach reason events, view or copied summary", async () => {
  const events: JobEventDto[] = [];
  const manager = new JobManager({
    clock: () => new Date("2024-01-01T00:00:00Z"), emit: event => events.push(event),
    sessions: { create: async () => ({ proxy: { mode: "direct", display: "直连" },
      transport: async () => { throw Error("unused"); } }), close: async () => {} },
    wayback: { queryPage: async () => { throw new AppError("NETWORK", json, {
      context: { httpStatus: 504, stage: "http", attempts: 3 },
    }); } },
    commoncrawl: { fetchIndexes: async () => ({ metas: [], invalidCount: 0 }), pageCount: async () => 0,
      queryPage: async () => ({ records: [], reasons: [], hasMore: false, parseSkipped: 0 }) },
  });
  const started = await manager.start({ target: "example.com", source: "wayback", range: { kind: "all" }, proxy: { mode: "direct" } });
  assert.ok(started.ok);
  const view = () => {
    const result = manager.getView({ jobId: started.value.jobId, source: "wayback", filter: EMPTY_FILTER,
      sort: { key: null, reverse: false }, pageIndex: 0, pageSize: 50 });
    assert.ok(result.ok); return result.value;
  };
  const deadline = Date.now() + 1000;
  while (!view().terminal) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 2)); }
  const finalView = view();
  const copy = manager.copyReasons({ jobId: started.value.jobId, source: "wayback", revision: finalView.revision });
  assert.ok(copy.ok);
  for (const output of [JSON.stringify(events), JSON.stringify(finalView), copy.value.text]) {
    assert.ok(!output.includes(marker));
  }
  assert.deepEqual(finalView.reasons[0].context, { httpStatus: 504, stage: "http", attempts: 3 });
});

test("trusted HTTP diagnostics remain actionable", () => {
  const error = new AppError("NETWORK", "来源网关超时（HTTP 504）", {
    context: { stage: "cc-page-count", httpStatus: 504, attempts: 3 },
  });
  assert.match(error.toDto().message, /HTTP 504/);
  assert.deepEqual(error.toDto().context, { stage: "cc-page-count", httpStatus: 504, attempts: 3 });
});

for (const code of [undefined, "EACCES", `UNSAFE_${marker}`]) {
  test(`unknown export error uses a fixed template (${code === "EACCES" ? "safe code" : "no safe code"})`, async () => {
    const original = fs.writeFile;
    try {
      fs.writeFile = async () => { throw Object.assign(new Error(marker), { code, path: marker, cause: { password: marker } }); };
      await assert.rejects(writeExport([], "json", "export-boundary-fixture.json"), (error: AppError) => {
        assert.equal(error.code, "EXPORT");
        assert.ok(!error.message.includes(marker));
        assert.ok(!JSON.stringify(error.toDto()).includes(marker));
        assert.equal(error.message.includes("EACCES"), code === "EACCES");
        assert.equal(sanitizePublicText(error.message), error.message);
        return true;
      });
    } finally { fs.writeFile = original; }
  });
}
