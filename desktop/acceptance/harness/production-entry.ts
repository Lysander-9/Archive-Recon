/**
 * Production entry for the independent acceptance bundle.
 *
 * Only files under desktop/acceptance are authored here; this entry re-exports
 * the real production modules. `prepare.mjs` bundles it with esbuild so the
 * acceptance tests import compiled production code (Node's type stripping
 * cannot handle TypeScript parameter properties used by JobManager).
 */

export * from "../../src/contracts/index";
export * from "../../src/domain/index";
export * from "../../src/application/index";
export { WaybackAdapter, DEFAULT_WAYBACK_URL } from "../../src/main/adapters/wayback";
export { CommonCrawlAdapter, DEFAULT_CC_BASE } from "../../src/main/adapters/commoncrawl";
export { csvBuffer, jsonBuffer, writeExport, exportFileName } from "../../src/main/export";
export { buildProxyConfig, proxySnapshot, redactProxy } from "../../src/main/adapters/proxy";
