/**
 * Per-task Electron session isolation.
 *
 * Proxy credentials are parsed out of the proxy URL, kept only in memory for the
 * task, and answered on the Chromium proxy challenge (`ClientRequest` "login"
 * event). They never appear in proxy rules, snapshots, errors or logs.
 * SOCKS authentication is not provided by Chromium, so it is rejected
 * explicitly instead of pretending to support it or falling back to direct.
 */

import { net, session as electronSession, type Session } from "electron";
import type { HttpResponseLike, JobSession, SessionFactory, Transport } from "../application/ports";
import type { ProxySpec } from "../contracts/types";
import { AppError } from "../application/errors";
import {
  buildProxyConfig,
  parseProxyServer,
  proxySnapshot,
  type ParsedProxyServer,
} from "./adapters/proxy";

interface ProxyCredentials {
  username: string;
  password: string;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function createTransport(
  isolated: Session,
  credentials: ProxyCredentials | null,
): Transport {
  return (url, init) =>
    new Promise<HttpResponseLike>((resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(abortError());
        return;
      }
      let settled = false;
      const request = net.request({
        url,
        session: isolated,
        method: "GET",
        redirect: "follow",
        useSessionCookies: false,
      });

      const cleanup = (): void => {
        init?.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        try {
          request.abort();
        } catch {
          // already finished
        }
        fail(abortError());
      };
      init?.signal?.addEventListener("abort", onAbort, { once: true });

      if (credentials) {
        request.on("login", (authInfo, callback) => {
          if (authInfo?.isProxy) {
            callback(credentials.username, credentials.password);
          } else {
            // Never answer origin authentication with proxy credentials.
            callback();
          }
        });
      }

      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          if (settled) return;
          settled = true;
          cleanup();
          const body = Buffer.concat(chunks);
          resolve({
            status: response.statusCode,
            text: async () => body.toString("utf8"),
            json: async () => JSON.parse(body.toString("utf8")),
          });
        });
        response.on("error", fail);
      });
      request.on("error", fail);
      request.end();
    });
}

export interface ElectronSessionFactory extends SessionFactory {
  sessions: Map<number, Session>;
}

export function createElectronSessions(): ElectronSessionFactory {
  const sessions = new Map<number, Session>();

  return {
    sessions,
    async create(jobId: number, proxy: ProxySpec): Promise<JobSession> {
      let parsed: ParsedProxyServer | null = null;
      let credentials: ProxyCredentials | null = null;
      if (proxy.mode === "fixed") {
        parsed = parseProxyServer(proxy.server ?? "");
        if (parsed.hasCredentials) {
          if (parsed.protocol === "socks5:") {
            throw new AppError(
              "PROXY",
              "当前版本不支持 SOCKS 代理认证（Chromium 未提供该能力），请改用无需认证的 SOCKS5，或使用 HTTP 代理认证；本次任务不会回退为直连",
              { retryable: false },
            );
          }
          credentials = {
            username: parsed.username as string,
            password: parsed.password as string,
          };
        }
      }
      const config = buildProxyConfig(proxy);

      const isolated = electronSession.fromPartition(`archive-job-${jobId}`, { cache: false });
      try {
        await isolated.setProxy(config);
      } catch {
        const detail = parsed ? `（${parsed.hostname}:${parsed.port}）` : "";
        throw new AppError("PROXY", `代理设置失败${detail}；本次任务已停止，不会回退为直连`, {
          retryable: false,
        });
      }
      sessions.set(jobId, isolated);
      return { transport: createTransport(isolated, credentials), proxy: proxySnapshot(proxy) };
    },
    async close(jobId: number): Promise<void> {
      const isolated = sessions.get(jobId);
      sessions.delete(jobId);
      if (!isolated) return;
      try {
        await isolated.clearCache();
      } catch {
        // best effort
      }
      try {
        await isolated.closeAllConnections();
      } catch {
        // best effort
      }
    },
  };
}
