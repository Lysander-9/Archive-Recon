/**
 * Non-loopback proxy verification for the production session factory.
 *
 * Chromium bypasses loopback for fixed proxies by default, so a 127.0.0.1 proxy
 * fixture cannot prove the production path. This runner binds the origin and the
 * proxy to the machine's non-loopback IPv4 address, keeps the production proxy
 * config untouched (no "<-loopback>" override) and proves:
 *   - plain HTTP proxy is used (proxy rewrites the response body),
 *   - authenticated HTTP proxy works through the per-task challenge handler,
 *   - a failing proxy never falls back to direct,
 *   - credentials never appear in the returned error/result text.
 *
 * Run: node tests/integration/run-proxy-nonloopback.mjs
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const generated = path.join(here, ".generated-proxy-nonloopback.cjs");

const harness = String.raw`
const { app } = require("electron");
const http = require("node:http");
const os = require("node:os");
const { createElectronSessions } = require("../../src/main/sessions");
const { parseProxyServer } = require("../../src/main/adapters/proxy");

const results = [];
const servers = [];

function nonLoopbackAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.listen(0, host, () => resolve(server.address().port));
    server.on("error", reject);
  });
}

function originServer(host) {
  const server = http.createServer((_request, response) => {
    response.end("ORIGIN_OK");
  });
  return server;
}

function proxyServer(host, options = {}) {
  let hits = 0;
  let authorized = 0;
  const server = http.createServer((request, response) => {
    hits += 1;
    if (options.auth) {
      const expected = "Basic " + Buffer.from(options.auth.user + ":" + options.auth.pass).toString("base64");
      if (request.headers["proxy-authorization"] !== expected) {
        response.statusCode = 407;
        response.setHeader("Proxy-Authenticate", 'Basic realm="nonloopback"');
        response.end("auth required");
        return;
      }
      authorized += 1;
    }
    const target = new URL(request.url);
    const upstream = http.request(
      { hostname: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: request.method, headers: request.headers },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode || 502, { "content-type": "text/plain" });
        response.end("VIA_PROXY");
      },
    );
    upstream.on("error", () => { response.statusCode = 502; response.end("proxy upstream error"); });
    request.pipe(upstream);
  });
  return { server, hits: () => hits, authorized: () => authorized };
}

async function fetchVia(serverUrl, targetUrl) {
  const sessions = createElectronSessions();
  try {
    const job = await sessions.create(1, { mode: "fixed", server: serverUrl });
    try {
      const response = await job.transport(targetUrl, {});
      return { ok: response.status >= 200 && response.status < 300, status: response.status, text: await response.text(), proxy: job.proxy };
    } finally {
      await sessions.close(1);
    }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

async function closeAll() {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
}

async function run() {
  await app.whenReady();
  const host = nonLoopbackAddress();
  if (!host) {
    console.log("PROXY_NONLOOPBACK_RESULT " + JSON.stringify({ skipped: "no non-loopback IPv4 interface" }));
    app.exit(0);
    return;
  }

  const origin = originServer(host); servers.push(origin);
  const originPort = await listen(origin, host);
  const targetUrl = "http://" + host + ":" + originPort + "/health";

  const plain = proxyServer(host); servers.push(plain.server);
  const plainPort = await listen(plain.server, host);
  const plainResult = await fetchVia("http://" + host + ":" + plainPort, targetUrl);
  results.push({
    id: "non-loopback-http-proxy",
    ok: plainResult.ok && plainResult.text === "VIA_PROXY" && plain.hits() > 0,
    body: plainResult.text,
    proxyHits: plain.hits(),
  });

  const auth = proxyServer(host, { auth: { user: "acceptance", pass: "s3cret" } }); servers.push(auth.server);
  const authPort = await listen(auth.server, host);
  const authResult = await fetchVia("http://acceptance:s3cret@" + host + ":" + authPort, targetUrl);
  results.push({
    id: "non-loopback-http-proxy-auth",
    ok: authResult.ok && authResult.text === "VIA_PROXY" && auth.authorized() > 0,
    body: authResult.text,
    authorized: auth.authorized(),
    dto: JSON.stringify(authResult.proxy || null),
  });

  const wrong = proxyServer(host, { auth: { user: "acceptance", pass: "expected" } }); servers.push(wrong.server);
  const wrongPort = await listen(wrong.server, host);
  const wrongResult = await fetchVia("http://acceptance:s3cret@" + host + ":" + wrongPort, targetUrl);
  const wrongText = JSON.stringify(wrongResult);
  results.push({
    id: "non-loopback-auth-failure-no-direct",
    ok: !wrongResult.ok && wrong.authorized() === 0 && !wrongText.includes("s3cret"),
    detail: wrongResult.error || ("status=" + wrongResult.status),
    authorized: wrong.authorized(),
    leaked: wrongText.includes("s3cret"),
  });

  const deadPort = 1;
  const before = plain.hits();
  const failure = await fetchVia("http://" + host + ":" + deadPort, targetUrl);
  results.push({
    id: "non-loopback-proxy-failure-no-direct",
    ok: !failure.ok && plain.hits() === before,
    detail: failure.error || ("status=" + failure.status),
  });

  const parsed = parseProxyServer("http://acceptance:s3cret@" + host + ":" + authPort);
  results.push({
    id: "proxy-rules-have-no-credentials",
    ok: parsed.baseServer === "http://" + host + ":" + authPort && !parsed.baseServer.includes("s3cret"),
    baseServer: parsed.baseServer,
  });

  console.log("PROXY_NONLOOPBACK_RESULT " + JSON.stringify({ host, results }));
  await closeAll();
  app.exit(results.every((item) => item.ok) ? 0 : 1);
}

run().catch(async (error) => {
  console.log("PROXY_NONLOOPBACK_RESULT " + JSON.stringify({ fatal: String(error) }));
  await closeAll().catch(() => undefined);
  app.exit(2);
});
`;

await build({
  stdin: { contents: harness, resolveDir: here, loader: "js" },
  outfile: generated,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  logLevel: "silent",
});

const electronBinary = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const result = spawnSync(electronBinary, [generated], { encoding: "utf8" });
await fs.rm(generated, { force: true }).catch(() => undefined);

const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
console.log(output || "(no output)");
process.exit(result.status ?? 1);
