/**
 * Real Electron proxy acceptance (loopback only).
 *
 * Runs with the production createElectronSessions()/session.fetch path and
 * local HTTP/SOCKS5 proxy servers. No external network.
 *
 * Usage (after `node acceptance/prepare.mjs`):
 *   node_modules/.bin/electron acceptance/proxy/generated/run-proxy-acceptance.cjs
 */

import { app } from "electron";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { createElectronSessions } from "../../src/main/sessions";
import { buildProxyConfig } from "../../src/main/adapters/proxy";

interface Result {
  id: string;
  ok: boolean;
  gap?: boolean;
  detail: string;
  originHits?: number;
  proxyHits?: number;
}

const results: Result[] = [];
const servers: Array<http.Server | net.Server> = [];

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    server.on("error", reject);
  });
}

function closeAll(): Promise<void> {
  return Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  ).then(() => undefined);
}

function originServer() {
  let hits = 0;
  const server = http.createServer((_request, response) => {
    hits += 1;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end("ORIGIN_OK");
  });
  return { server, hits: () => hits };
}

function httpProxy(options: { auth?: { user: string; pass: string } }) {
  let hits = 0;
  let authorized = 0;
  const server = http.createServer((request, response) => {
    hits += 1;
    if (options.auth) {
      const header = request.headers["proxy-authorization"];
      const expected = `Basic ${Buffer.from(`${options.auth.user}:${options.auth.pass}`).toString("base64")}`;
      if (header !== expected) {
        response.statusCode = 407;
        response.setHeader("Proxy-Authenticate", 'Basic realm="acceptance"');
        response.end("proxy auth required");
        return;
      }
      authorized += 1;
    }
    if (!request.url || !/^https?:\/\//.test(request.url)) {
      response.statusCode = 400;
      response.end("absolute URL required");
      return;
    }
    const target = new URL(request.url);
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: request.headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      response.statusCode = 502;
      response.end("proxy upstream error");
    });
    request.pipe(upstream);
  });
  server.on("connect", (request, clientSocket, head) => {
    hits += 1;
    const [host, portText] = (request.url ?? "").split(":");
    const upstream = net.connect(Number(portText || 443), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
  });
  return { server, hits: () => hits, authorized: () => authorized };
}

function readExact(socket: net.Socket): {
  read: (length: number) => Promise<Buffer>;
} {
  let buffer = Buffer.alloc(0);
  const waiters: Array<() => void> = [];
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (const waiter of waiters.splice(0)) waiter();
  });
  const read = async (length: number): Promise<Buffer> => {
    while (buffer.length < length) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    const out = buffer.subarray(0, length);
    buffer = buffer.subarray(length);
    return out;
  };
  return { read };
}

function socks5Proxy(options: { auth?: { user: string; pass: string } }) {
  let hits = 0;
  const server = net.createServer((socket) => {
    const reader = readExact(socket);
    void (async () => {
      try {
        const greeting = await reader.read(2);
        const methods = await reader.read(greeting[1]);
        const required = options.auth ? 0x02 : 0x00;
        if (!methods.includes(required)) {
          socket.end(Buffer.from([0x05, 0xff]));
          return;
        }
        socket.write(Buffer.from([0x05, required]));
        if (options.auth) {
          const authHeader = await reader.read(2);
          const user = (await reader.read(authHeader[1])).toString("utf8");
          const passLength = await reader.read(1);
          const pass = (await reader.read(passLength[0])).toString("utf8");
          if (user !== options.auth.user || pass !== options.auth.pass) {
            socket.end(Buffer.from([0x01, 0x01]));
            return;
          }
          socket.write(Buffer.from([0x01, 0x00]));
        }
        const request = await reader.read(4);
        const atyp = request[3];
        let host = "";
        if (atyp === 0x01) {
          host = Array.from(await reader.read(4)).join(".");
        } else if (atyp === 0x03) {
          const length = (await reader.read(1))[0];
          host = (await reader.read(length)).toString("utf8");
        } else {
          socket.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const portBuffer = await reader.read(2);
        const port = portBuffer.readUInt16BE(0);
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

async function fetchVia(
  proxy: any,
  url: string,
  forceLoopbackThroughProxy = false,
): Promise<{ ok: boolean; text: string; error?: string }> {
  const sessions = createElectronSessions();
  try {
    const job = await sessions.create(1, proxy);
    if (forceLoopbackThroughProxy) {
      // Chromium bypasses loopback for fixed proxies by default. The product
      // config does not add "<-loopback>", so this is only used to validate
      // the proxy servers/protocol path and is reported as a test-only override.
      const isolated = sessions.sessions.get(1);
      await isolated?.setProxy({
        ...buildProxyConfig(proxy),
        proxyBypassRules: "<-loopback>",
      });
    }
    try {
      const response = await job.transport(url, {});
      const text = await response.text();
      return { ok: response.status >= 200 && response.status < 300, text };
    } finally {
      await sessions.close(1);
    }
  } catch (error) {
    return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
  }
}

async function createOnly(proxy: any): Promise<{ ok: boolean; code?: string; message?: string }> {
  const sessions = createElectronSessions();
  try {
    await sessions.create(1, proxy);
    await sessions.close(1).catch(() => undefined);
    return { ok: false, message: "session was created unexpectedly" };
  } catch (error) {
    return {
      ok: true,
      code: (error as any)?.code,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function run(): Promise<void> {
  await app.whenReady();

  const origin = originServer();
  servers.push(origin.server);
  const originPort = await listen(origin.server);
  const originUrl = `http://127.0.0.1:${originPort}/wayback`;

  const plainProxy = httpProxy({});
  servers.push(plainProxy.server);
  const plainPort = await listen(plainProxy.server);

  const authProxy = httpProxy({ auth: { user: "acceptance", pass: "secret" } });
  servers.push(authProxy.server);
  const authPort = await listen(authProxy.server);

  const socksPlain = socks5Proxy({});
  servers.push(socksPlain.server);
  const socksPort = await listen(socksPlain.server);

  const socksAuth = socks5Proxy({ auth: { user: "acceptance", pass: "secret" } });
  servers.push(socksAuth.server);
  const socksAuthPort = await listen(socksAuth.server);

  const defaultBefore = origin.hits();
  const defaultResult = await fetchVia(
    { mode: "fixed", server: `http://127.0.0.1:${plainPort}` },
    originUrl,
  );
  results.push({
    id: "loopback-default-config",
    ok: false,
    gap: true,
    detail: `production config bypasses loopback: originHits=${origin.hits() - defaultBefore}, proxyHits=${plainProxy.hits()}; this is a test-environment gap, not a granted success`,
    originHits: origin.hits() - defaultBefore,
    proxyHits: plainProxy.hits(),
  });

  const httpResult = await fetchVia(
    { mode: "fixed", server: `http://127.0.0.1:${plainPort}` },
    originUrl,
    true,
  );
  results.push({
    id: "http-proxy",
    ok: httpResult.ok && plainProxy.hits() > 0,
    detail: httpResult.ok ? `status ok; proxyHits=${plainProxy.hits()}` : `error=${httpResult.error}`,
    originHits: origin.hits(),
    proxyHits: plainProxy.hits(),
  });

  const authBefore = origin.hits();
  const authResult = await fetchVia(
    { mode: "fixed", server: `http://acceptance:secret@127.0.0.1:${authPort}` },
    originUrl,
    true,
  );
  results.push({
    id: "http-proxy-auth",
    ok: authResult.ok && authProxy.authorized() > 0,
    detail: authResult.ok
      ? `status ok; authorized=${authProxy.authorized()}`
      : `error=${authResult.error}; authorized=${authProxy.authorized()}`,
    originHits: origin.hits() - authBefore,
    proxyHits: authProxy.hits(),
  });

  const socksBefore = origin.hits();
  const socksResult = await fetchVia(
    { mode: "fixed", server: `socks5://127.0.0.1:${socksPort}` },
    originUrl,
    true,
  );
  results.push({
    id: "socks5-proxy",
    ok: socksResult.ok && socksPlain.hits() > 0,
    detail: socksResult.ok ? `status ok; socksHits=${socksPlain.hits()}` : `error=${socksResult.error}`,
    originHits: origin.hits() - socksBefore,
    proxyHits: socksPlain.hits(),
  });

  const socksAuthBefore = origin.hits();
  const socksAuthProxyBefore = socksAuth.hits();
  const socksAuthRejection = await createOnly({
    mode: "fixed",
    server: `socks5://acceptance:secret@127.0.0.1:${socksAuthPort}`,
  });
  const socksAuthHits = socksAuth.hits() - socksAuthProxyBefore;
  const socksAuthOriginHits = origin.hits() - socksAuthBefore;
  results.push({
    id: "socks5-auth-rejected",
    ok: socksAuthRejection.ok && socksAuthRejection.code === "PROXY" &&
      socksAuthHits === 0 && socksAuthOriginHits === 0,
    detail: socksAuthRejection.ok
      ? `rejected before start; code=${socksAuthRejection.code}; originHits=${socksAuthOriginHits}; socksHits=${socksAuthHits}`
      : `unexpected: ${socksAuthRejection.message}`,
    originHits: socksAuthOriginHits,
    proxyHits: socksAuthHits,
  });

  const failureBefore = origin.hits();
  const failureResult = await fetchVia(
    { mode: "fixed", server: "http://127.0.0.1:1" },
    originUrl,
    true,
  );
  results.push({
    id: "proxy-failure-no-direct",
    ok: !failureResult.ok && origin.hits() === failureBefore,
    detail: failureResult.ok ? "unexpected success" : `error=${failureResult.error}`,
    originHits: origin.hits() - failureBefore,
    proxyHits: 0,
  });

  console.log(`PROXY_ACCEPTANCE_RESULT ${JSON.stringify({ results })}`);
  await closeAll();
  app.exit(results.every((item) => item.ok || item.gap) ? 0 : 1);
}

run().catch(async (error) => {
  console.log(`PROXY_ACCEPTANCE_RESULT ${JSON.stringify({ results, fatal: String(error) })}`);
  await closeAll().catch(() => undefined);
  app.exit(2);
});
