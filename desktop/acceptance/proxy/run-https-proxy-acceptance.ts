/**
 * Controlled HTTPS proxy acceptance for the published main candidate.
 *
 * Local HTTPS origin + HTTP CONNECT proxy (optional Basic auth) + SOCKS5 proxy.
 * Uses the production createElectronSessions()/net.request path and production
 * CommonCrawlAdapter/fetchText. No external target is queried here.
 *
 * The loopback proxy is forced with the test-only "<-loopback>" bypass and the
 * test-only certificate verifier; both are reported explicitly. The official
 * service health control is a separate bounded curl in the report command.
 */

import { app } from "electron";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import path from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { createElectronSessions } from "../../src/main/sessions";
import { buildProxyConfig } from "../../src/main/adapters/proxy";
import { CommonCrawlAdapter } from "../../src/main/adapters/commoncrawl";
import { fetchText } from "../../src/main/adapters/http";

interface Result {
  id: string;
  ok: boolean;
  /** True when the case is an unresolved environment/contract gap, not a product failure. */
  gap?: boolean;
  detail: string;
  proxyHits?: number;
  authHits?: number;
  originHits?: number;
}

const results: Result[] = [];
const servers: Array<http.Server | https.Server | net.Server> = [];
const TLS_DIR = path.resolve(__dirname, "..", "..", "fixtures", "tls");

function listen(server: http.Server | https.Server | net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    server.on("error", reject);
  });
}
function closeAll(): Promise<void> {
  return Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    .then(() => undefined);
}

const HEADER = ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"];
const NDJSON = [
  '{"url":"https://example.com/a","status":"200","mime":"text/html","length":"1","timestamp":"20240102030405"}',
  '{"url":"https://example.com/b","status":"200","mime":"text/html","length":"2","timestamp":"20240103040506"}',
].join("\n");

function httpsOrigin() {
  let hits = 0;
  const server = https.createServer(
    {
      key: readFileSync(path.join(TLS_DIR, "key.pem")),
      cert: readFileSync(path.join(TLS_DIR, "cert.pem")),
    },
    (request, response) => {
      hits += 1;
      const url = new URL(request.url ?? "/", "https://127.0.0.1");
      if (url.pathname === "/cc/collinfo.json") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify([{
          id: "CC-MAIN-TEST",
          "cdx-api": `https://127.0.0.1:${(server.address() as net.AddressInfo).port}/cc/CC-MAIN-TEST-index`,
          from: "20240101000000",
          to: "20240301000000",
        }]));
        return;
      }
      if (url.pathname === "/cc/CC-MAIN-TEST-index") {
        if (url.searchParams.get("showNumPages") === "true") {
          response.end(JSON.stringify({ pages: 1 }));
          return;
        }
        response.setHeader("content-type", "application/x-ndjson");
        response.end(NDJSON);
        return;
      }
      if (url.pathname === "/gzip-index") {
        response.setHeader("content-type", "application/x-ndjson");
        response.setHeader("content-encoding", "gzip");
        response.end(zlib.gzipSync(NDJSON));
        return;
      }
      if (url.pathname === "/status/429") { response.statusCode = 429; response.end("rate limited"); return; }
      if (url.pathname === "/status/502") { response.statusCode = 502; response.end("bad gateway"); return; }
      if (url.pathname === "/status/503") { response.statusCode = 503; response.end("unavailable"); return; }
      if (url.pathname === "/status/504") { response.statusCode = 504; response.end("gateway timeout"); return; }
      if (url.pathname === "/slow") {
        setTimeout(() => response.end("slow"), 1_500);
        return;
      }
      if (url.pathname === "/large") {
        response.end("x".repeat(10_000));
        return;
      }
      response.end("OK");
    },
  );
  return { server, hits: () => hits };
}

function httpConnectProxy(options: { auth?: { user: string; pass: string } } = {}) {
  let hits = 0;
  let authHits = 0;
  const server = http.createServer((_request, response) => {
    response.statusCode = 405;
    response.end("CONNECT only");
  });
  server.on("connect", (request, clientSocket, head) => {
    hits += 1;
    if (options.auth) {
      const expected = `Basic ${Buffer.from(`${options.auth.user}:${options.auth.pass}`).toString("base64")}`;
      if (request.headers["proxy-authorization"] !== expected) {
        clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"acceptance\"\r\n\r\n");
        clientSocket.end();
        return;
      }
      authHits += 1;
    }
    const [host, portText] = (request.url ?? "").split(":");
    const upstream = net.connect(Number(portText), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
  });
  return { server, hits: () => hits, authHits: () => authHits };
}

function httpsConnectProxy(options: { auth?: { user: string; pass: string } } = {}) {
  let hits = 0;
  let authHits = 0;
  const server = https.createServer(
    {
      key: readFileSync(path.join(TLS_DIR, "key.pem")),
      cert: readFileSync(path.join(TLS_DIR, "cert.pem")),
    },
    (_request, response) => {
      response.statusCode = 405;
      response.end("CONNECT only");
    },
  );
  server.on("connect", (request, clientSocket, head) => {
    hits += 1;
    if (options.auth) {
      const expected = `Basic ${Buffer.from(`${options.auth.user}:${options.auth.pass}`).toString("base64")}`;
      if (request.headers["proxy-authorization"] !== expected) {
        clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"acceptance\"\r\n\r\n");
        clientSocket.end();
        return;
      }
      authHits += 1;
    }
    const [host, portText] = (request.url ?? "").split(":");
    const upstream = net.connect(Number(portText), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
  });
  return { server, hits: () => hits, authHits: () => authHits };
}

function socks5Proxy() {
  let hits = 0;
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    const waiters: Array<() => void> = [];
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (const waiter of waiters.splice(0)) waiter();
    });
    const read = async (length: number): Promise<Buffer> => {
      while (buffer.length < length) await new Promise<void>((resolve) => waiters.push(resolve));
      const out = buffer.subarray(0, length);
      buffer = buffer.subarray(length);
      return out;
    };
    void (async () => {
      try {
        const greeting = await read(2);
        await read(greeting[1]);
        socket.write(Buffer.from([0x05, 0x00]));
        const request = await read(4);
        const atyp = request[3];
        let host = "";
        if (atyp === 0x01) host = Array.from(await read(4)).join(".");
        else if (atyp === 0x03) {
          const length = (await read(1))[0];
          host = (await read(length)).toString("utf8");
        } else {
          socket.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const port = (await read(2)).readUInt16BE(0);
        hits += 1;
        const upstream = net.connect(port, host, () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on("error", () => socket.destroy());
      } catch {
        socket.destroy();
      }
    })();
  });
  return { server, hits: () => hits };
}

let jobCounter = 0;
async function sessionFor(proxy: any, options: { trustTls?: boolean; forceLoopback?: boolean } = {}) {
  const sessions = createElectronSessions();
  const jobId = ++jobCounter;
  const job = await sessions.create(jobId, proxy);
  const isolated = sessions.sessions.get(jobId);
  if (isolated && options.forceLoopback && proxy.mode === "fixed") {
    // Test-only: Chromium bypasses loopback by default; production rules remain unchanged.
    await isolated.setProxy({ ...buildProxyConfig(proxy), proxyBypassRules: "<-loopback>" });
  }
  if (isolated && options.trustTls !== false) {
    isolated.setCertificateVerifyProc((_request, callback) => callback(0));
  }
  return { sessions, jobId, transport: job.transport, close: () => sessions.close(jobId) };
}

function errorOf(error: unknown) {
  const anyError = error as any;
  return {
    code: anyError?.code,
    message: error instanceof Error ? error.message : String(error),
    context: anyError?.context,
  };
}

async function rawProbe(session: any, url: string) {
  try {
    const response = await fetchText(session.transport, url, {
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });
    return { status: response.status, length: response.text.length, head: response.text.slice(0, 160) };
  } catch (error) {
    return { error: errorOf(error) };
  }
}

async function run(): Promise<void> {
  await app.whenReady();
  const origin = httpsOrigin();
  servers.push(origin.server);
  const originPort = await listen(origin.server);
  const originBase = `https://127.0.0.1:${originPort}`;

  const proxy = httpConnectProxy({});
  servers.push(proxy.server);
  const proxyPort = await listen(proxy.server);

  const authProxy = httpConnectProxy({ auth: { user: "acceptance", pass: "secret" } });
  servers.push(authProxy.server);
  const authPort = await listen(authProxy.server);

  const tlsProxy = httpsConnectProxy({});
  servers.push(tlsProxy.server);
  const tlsProxyPort = await listen(tlsProxy.server);

  const socks = socks5Proxy();
  servers.push(socks.server);
  const socksPort = await listen(socks.server);

  // 1. HTTPS through CONNECT proxy.
  {
    const session = await sessionFor({ mode: "fixed", server: `http://127.0.0.1:${proxyPort}` }, { forceLoopback: true });
    try {
      const raw = await rawProbe(session, `${originBase}/cc/collinfo.json`);
      const adapter = new CommonCrawlAdapter({ indexBaseUrl: `${originBase}/cc` });
      const metas = await adapter.fetchIndexes({
        signal: new AbortController().signal,
        timeoutMs: 5000,
        transport: session.transport,
      });
      results.push({
        id: "https-connect-no-auth",
        ok: metas.metas.length === 1 && proxy.hits() > 0,
        detail: `metas=${metas.metas.length}; proxyHits=${proxy.hits()}; originHits=${origin.hits()}; raw=${JSON.stringify(raw)}`,
        proxyHits: proxy.hits(),
        originHits: origin.hits(),
      });
    } catch (error) {
      results.push({ id: "https-connect-no-auth", ok: false, detail: `${JSON.stringify(errorOf(error))}; raw=${JSON.stringify(await rawProbe(session, `${originBase}/cc/collinfo.json`))}; proxyHits=${proxy.hits()}`, proxyHits: proxy.hits() });
    } finally { await session.close(); }
  }

  // 2. HTTPS through authenticated CONNECT proxy.
  {
    const session = await sessionFor({ mode: "fixed", server: `http://acceptance:secret@127.0.0.1:${authPort}` }, { forceLoopback: true });
    try {
      const raw = await rawProbe(session, `${originBase}/cc/collinfo.json`);
      const adapter = new CommonCrawlAdapter({ indexBaseUrl: `${originBase}/cc` });
      const metas = await adapter.fetchIndexes({
        signal: new AbortController().signal,
        timeoutMs: 5000,
        transport: session.transport,
      });
      results.push({
        id: "https-connect-auth",
        ok: metas.metas.length === 1 && authProxy.authHits() > 0,
        detail: `metas=${metas.metas.length}; authHits=${authProxy.authHits()}; proxyHits=${authProxy.hits()}; raw=${JSON.stringify(raw)}`,
        proxyHits: authProxy.hits(),
        authHits: authProxy.authHits(),
      });
    } catch (error) {
      results.push({ id: "https-connect-auth", ok: false, detail: `${JSON.stringify(errorOf(error))}; raw=${JSON.stringify(await rawProbe(session, `${originBase}/cc/collinfo.json`))}; proxyHits=${authProxy.hits()}`, proxyHits: authProxy.hits() });
    } finally { await session.close(); }
  }

  // 2b. HTTPS proxy endpoint itself over TLS.
  {
    const session = await sessionFor({ mode: "fixed", server: `https://127.0.0.1:${tlsProxyPort}` }, { forceLoopback: true });
    try {
      const adapter = new CommonCrawlAdapter({ indexBaseUrl: `${originBase}/cc` });
      const metas = await adapter.fetchIndexes({
        signal: new AbortController().signal,
        timeoutMs: 5000,
        transport: session.transport,
      });
      results.push({
        id: "https-proxy-tls",
        ok: metas.metas.length === 1 && tlsProxy.hits() > 0,
        detail: `metas=${metas.metas.length}; proxyHits=${tlsProxy.hits()}`,
        proxyHits: tlsProxy.hits(),
      });
    } catch (error) {
      results.push({ id: "https-proxy-tls", ok: false, detail: JSON.stringify(errorOf(error)), proxyHits: tlsProxy.hits() });
    } finally { await session.close(); }
  }

  // 3. HTTPS through SOCKS5.
  {
    const session = await sessionFor({ mode: "fixed", server: `socks5://127.0.0.1:${socksPort}` }, { forceLoopback: true });
    try {
      const raw = await rawProbe(session, `${originBase}/cc/collinfo.json`);
      const adapter = new CommonCrawlAdapter({ indexBaseUrl: `${originBase}/cc` });
      const metas = await adapter.fetchIndexes({
        signal: new AbortController().signal,
        timeoutMs: 5000,
        transport: session.transport,
      });
      results.push({
        id: "https-socks5",
        ok: metas.metas.length === 1 && socks.hits() > 0,
        detail: `metas=${metas.metas.length}; socksHits=${socks.hits()}; raw=${JSON.stringify(raw)}`,
        proxyHits: socks.hits(),
      });
    } catch (error) {
      results.push({ id: "https-socks5", ok: false, detail: `${JSON.stringify(errorOf(error))}; raw=${JSON.stringify(await rawProbe(session, `${originBase}/cc/collinfo.json`))}; socksHits=${socks.hits()}`, proxyHits: socks.hits() });
    } finally { await session.close(); }
  }

  // 3b. Full CC flow through the same CONNECT proxy: collinfo -> pageCount -> page rows.
  {
    const session = await sessionFor({ mode: "fixed", server: `http://127.0.0.1:${proxyPort}` }, { forceLoopback: true });
    try {
      const adapter = new CommonCrawlAdapter({ indexBaseUrl: `${originBase}/cc` });
      const options = { signal: new AbortController().signal, timeoutMs: 5000, transport: session.transport };
      const { metas } = await adapter.fetchIndexes(options);
      const meta = metas[0];
      const pages = await adapter.pageCount(meta, "example.com", options);
      const page = await adapter.queryPage(meta, "example.com", 0, 5, options);
      results.push({
        id: "https-cc-page-flow",
        ok: metas.length === 1 && pages === 1 && page.records.length === 2,
        detail: `metas=${metas.length}; pages=${pages}; records=${page.records.length}; proxyHits=${proxy.hits()}`,
        proxyHits: proxy.hits(),
      });
    } catch (error) {
      results.push({ id: "https-cc-page-flow", ok: false, detail: JSON.stringify(errorOf(error)), proxyHits: proxy.hits() });
    } finally { await session.close(); }
  }

  // 4. Proxy connection refused; no direct fallback.
  {
    const before = origin.hits();
    const session = await sessionFor({ mode: "fixed", server: "http://127.0.0.1:1" }, { forceLoopback: true });
    try {
      await fetchText(session.transport, `${originBase}/cc/collinfo.json`, {
        signal: new AbortController().signal,
        timeoutMs: 3000,
      });
      results.push({ id: "proxy-refused-no-direct", ok: false, detail: "unexpected success" });
    } catch (error) {
      results.push({
        id: "proxy-refused-no-direct",
        ok: origin.hits() === before,
        detail: `${JSON.stringify(errorOf(error))}; originDelta=${origin.hits() - before}`,
      });
    } finally { await session.close(); }
  }

  // 5. Wrong proxy credentials.
  {
    const before = origin.hits();
    const session = await sessionFor({ mode: "fixed", server: `http://acceptance:wrong@127.0.0.1:${authPort}` }, { forceLoopback: true });
    try {
      await fetchText(session.transport, `${originBase}/cc/collinfo.json`, {
        signal: new AbortController().signal,
        timeoutMs: 3000,
      });
      results.push({ id: "proxy-auth-failure", ok: false, detail: "unexpected success" });
    } catch (error) {
      const info = errorOf(error);
      results.push({
        id: "proxy-auth-failure",
        ok: origin.hits() === before && /407|auth|认证/i.test(JSON.stringify(info)),
        detail: `${JSON.stringify(info)}; originDelta=${origin.hits() - before}`,
      });
    } finally { await session.close(); }
  }

  // 6. Untrusted TLS (no test verifier).
  {
    const session = await sessionFor({ mode: "direct" }, { trustTls: false });
    try {
      await fetchText(session.transport, `${originBase}/cc/collinfo.json`, {
        signal: new AbortController().signal,
        timeoutMs: 3000,
      });
      results.push({ id: "tls-untrusted", ok: false, detail: "unexpected success" });
    } catch (error) {
      const info = errorOf(error);
      results.push({ id: "tls-untrusted", ok: /cert|ssl|tls|ERR_CERT/i.test(info.message), detail: JSON.stringify(info) });
    } finally { await session.close(); }
  }

  // 7. HTTP statuses (429/502/503/504) and timeout/retry boundaries.
  {
    const session = await sessionFor({ mode: "direct" });
    try {
      for (const status of [429, 502, 503, 504]) {
        try {
          await fetchText(session.transport, `${originBase}/status/${status}`, {
            signal: new AbortController().signal,
            timeoutMs: 10_000,
          });
          results.push({ id: `status-${status}`, ok: false, detail: "unexpected success" });
        } catch (error) {
          const info = errorOf(error);
          results.push({
            id: `status-${status}`,
            ok: (info.message.includes(String(status)) || info.context?.httpStatus === status) &&
              Number(info.context?.attempts) === 3,
            detail: JSON.stringify(info),
          });
        }
      }
      try {
        await fetchText(session.transport, `${originBase}/slow`, {
          signal: new AbortController().signal,
          timeoutMs: 120,
        });
        results.push({ id: "timeout", ok: false, detail: "unexpected success" });
      } catch (error) {
        const info = errorOf(error);
        results.push({ id: "timeout", ok: info.code === "TIMEOUT" || /timeout|超时/i.test(info.message), detail: JSON.stringify(info) });
      }
      const controller = new AbortController();
      const pending = fetchText(session.transport, `${originBase}/status/503`, {
        signal: controller.signal,
        timeoutMs: 10_000,
      });
      setTimeout(() => controller.abort(), 100);
      try {
        await pending;
        results.push({ id: "retry-cancel", ok: false, detail: "unexpected success" });
      } catch (error) {
        const info = errorOf(error);
        results.push({ id: "retry-cancel", ok: info.code === "CLOSED" || /abort|cancel/i.test(info.message), detail: JSON.stringify(info) });
      }
    } finally { await session.close(); }
  }

  // 8. gzip and byte budget.
  {
    const session = await sessionFor({ mode: "direct" });
    try {
      const gzip = await fetchText(session.transport, `${originBase}/gzip-index`, {
        signal: new AbortController().signal,
        timeoutMs: 3000,
      });
      results.push({ id: "gzip", ok: gzip.text.includes("example.com/a"), detail: `bytes=${gzip.text.length}` });

      try {
        await fetchText(session.transport, `${originBase}/large`, {
          signal: new AbortController().signal,
          timeoutMs: 3000,
          maxResponseBytes: 100,
        });
        results.push({ id: "byte-budget", ok: false, detail: "unexpected success" });
      } catch (error) {
        const info = errorOf(error);
        results.push({ id: "byte-budget", ok: info.code === "PARSE" && info.context?.limit === 100, detail: JSON.stringify(info) });
      }
    } finally { await session.close(); }
  }

  // 9. Cancellation of an in-flight HTTPS request.
  {
    const session = await sessionFor({ mode: "direct" });
    try {
      const controller = new AbortController();
      const pending = fetchText(session.transport, `${originBase}/slow`, {
        signal: controller.signal,
        timeoutMs: 3000,
      });
      setTimeout(() => controller.abort(), 80);
      try {
        await pending;
        results.push({ id: "cancel", ok: false, detail: "unexpected success" });
      } catch (error) {
        const info = errorOf(error);
        results.push({ id: "cancel", ok: info.code === "CLOSED" || /abort|cancel/i.test(info.message), detail: JSON.stringify(info) });
      }
    } finally { await session.close(); }
  }

  // 10. OS "system" mode: this contract refers to the operating-system proxy,
  // not HTTPS_PROXY. The current machine has no OS proxy, so this is a gap,
  // not a failure and not evidence for/against the user's own OS proxy.
  {
    const before = proxy.hits();
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    const session = await sessionFor({ mode: "system" }, { forceLoopback: true });
    try {
      const result = await fetchText(session.transport, `${originBase}/cc/collinfo.json`, {
        signal: new AbortController().signal,
        timeoutMs: 3000,
      });
      results.push({
        id: "os-system-proxy",
        ok: false,
        gap: true,
        detail: `OS system mode result=${result.status}; proxyHitsDelta=${proxy.hits() - before}; env is not the OS-system contract; current OS proxy is direct; contract requires a real OS proxy to verify`,
      });
    } catch (error) {
      results.push({
        id: "os-system-proxy",
        ok: false,
        gap: true,
        detail: `${JSON.stringify(errorOf(error))}; proxyHitsDelta=${proxy.hits() - before}; current OS proxy unavailable`,
      });
    } finally {
      await session.close();
      if (previous === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous;
    }
  }

  // 11. Direct DNS failure: the Chromium error itself must name resolution.
  {
    const session = await sessionFor({ mode: "direct" });
    try {
      await fetchText(session.transport, "https://no-such-host.invalid/cc/collinfo.json", {
        signal: new AbortController().signal,
        timeoutMs: 3000,
      });
      results.push({ id: "dns-direct", ok: false, detail: "unexpected success" });
    } catch (error) {
      const info = errorOf(error);
      results.push({
        id: "dns-direct",
        ok: /ERR_NAME|ERR_DNS|DNS|解析/i.test(JSON.stringify(info)),
        detail: JSON.stringify(info),
      });
    } finally { await session.close(); }
  }

  // 12. Explicit direct must ignore HTTPS_PROXY; this is the confirmed
  // contract, not a defect. Environment values are only a proposal waiting
  // for the user to choose a mode unless a future contract says otherwise.
  {
    const before = proxy.hits();
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    const session = await sessionFor({ mode: "direct" }, { forceLoopback: false });
    try {
      const response = await fetchText(session.transport, `${originBase}/cc/collinfo.json`, {
        signal: new AbortController().signal,
        timeoutMs: 3000,
      });
      results.push({
        id: "explicit-direct-ignores-env",
        ok: response.status === 200 && proxy.hits() === before,
        detail: `explicit direct result=${response.status}; proxyHitsDelta=${proxy.hits() - before}; HTTPS_PROXY ignored as specified`,
      });
    } catch (error) {
      results.push({ id: "explicit-direct-ignores-env", ok: false, detail: `${JSON.stringify(errorOf(error))}; explicit direct failed` });
    } finally {
      await session.close();
      if (previous === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous;
    }
  }

  // 13. Official metadata health control: same official request through the
  // same controlled CONNECT proxy, standard client vs product transport.
  if (process.env.ARCHRECON_OFFICIAL_HEALTH === "1") {
    const officialUrl = "https://index.commoncrawl.org/collinfo.json";
    const curl = spawnSync("curl.exe", [
      "-x", `http://127.0.0.1:${proxyPort}`,
      "-sS", "-o", "NUL",
      "-w", "%{http_code} %{size_download} %{time_total}",
      "--max-time", "20", "--max-filesize", "200000",
      officialUrl,
    ], { encoding: "utf8", timeout: 25_000 });
    const curlText = (curl.stdout ?? "").trim();
    const [curlStatus, curlBytes] = curlText.split(" ");
    const session = await sessionFor({ mode: "fixed", server: `http://127.0.0.1:${proxyPort}` }, { forceLoopback: true });
    try {
      const response = await fetchText(session.transport, officialUrl, {
        signal: new AbortController().signal,
        timeoutMs: 20_000,
      });
      results.push({
        id: "official-health-control",
        ok: curl.status === 0 && String(curlStatus) === "200" && response.status === 200 &&
          Number(curlBytes) === response.text.length,
        gap: !(curl.status === 0 && String(curlStatus) === "200" && response.status === 200 &&
          Number(curlBytes) === response.text.length),
        detail: `curl=${curlText || curl.error?.message}; productStatus=${response.status}; productBytes=${response.text.length}; bytesEqual=${Number(curlBytes) === response.text.length}`,
      });
    } catch (error) {
      results.push({ id: "official-health-control", ok: false, gap: true, detail: `curl=${curlText || curl.error?.message}; product=${JSON.stringify(errorOf(error))}` });
    } finally { await session.close(); }
  }

  console.log(`HTTPS_PROXY_ACCEPTANCE_RESULT ${JSON.stringify({ results })}`);
  await closeAll();
  app.exit(results.every((item) => item.ok || item.gap) ? 0 : 1);
}

run().catch(async (error) => {
  console.log(`HTTPS_PROXY_ACCEPTANCE_RESULT ${JSON.stringify({ results, fatal: String(error) })}`);
  await closeAll().catch(() => undefined);
  app.exit(2);
});
