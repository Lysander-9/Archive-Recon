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
import type { HttpResponseLike, JobLimits, JobSession, SessionFactory, Transport } from "../application/ports";
import type { ProxySpec } from "../contracts/types";
import { AppError } from "../application/errors";
import { DEFAULT_JOB_BUDGETS } from "../application/budgets";
import {
  buildProxyConfig,
  parseProxyServer,
  proxySnapshot,
  type ParsedProxyServer,
} from "./adapters/proxy";

interface ProxyCredentials {
  username: string;
  password: string;
  hostname: string;
  port: string;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function createTransport(
  isolated: Session,
  credentials: ProxyCredentials | null,
  maxResponseBytes: number,
): Transport {
  return (url, init) =>
    new Promise<HttpResponseLike>((resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(abortError());
        return;
      }
      let settled = false;
      let blockedRedirect = false;
      let blockedAuth = false;
      let proxyChallengeSeen = false;
      let authChallenges = 0;
      const authFailure = (): AppError =>
        new AppError(
          "PROXY",
          "代理认证失败（HTTP 407）：用户名或密码错误，本次任务已停止且不会直连",
          {
            retryable: false,
            context: { stage: "proxy-auth", kind: "proxy-auth", httpStatus: 407 },
          },
        );
      const authRequired = (): AppError =>
        new AppError(
          "PROXY",
          "代理要求认证（HTTP 407）：请在代理地址中填写用户名/密码，本次任务不会直连",
          {
            retryable: false,
            context: { stage: "proxy-auth", kind: "proxy-auth", httpStatus: 407 },
          },
        );
      const request = net.request({
        url,
        session: isolated,
        method: "GET",
        redirect: init?.onRedirect ? "manual" : "follow",
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

      if (init?.onRedirect) {
        request.on("redirect", (_status, _method, redirectUrl) => {
          if (!init.onRedirect!(redirectUrl)) {
            blockedRedirect = true;
            try {
              request.abort();
            } catch {
              // already aborted
            }
            return;
          }
          request.followRedirect();
        });
      }

      request.on("login", (authInfo, callback) => {
        if (!authInfo?.isProxy) {
          // Never answer origin authentication with proxy credentials.
          callback();
          return;
        }
        const matchesProxy =
          credentials !== null &&
          authInfo.host === credentials.hostname &&
          String(authInfo.port) === credentials.port;
        proxyChallengeSeen = true;
        if (!matchesProxy) {
          callback();
          return;
        }
        authChallenges += 1;
        if (authChallenges > 2) {
          blockedAuth = true;
          try {
            request.abort();
          } catch {
            // already aborted
          }
          fail(authFailure());
          return;
        }
        callback(credentials.username, credentials.password);
      });

      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          totalBytes += chunk.length;
          if (totalBytes > maxResponseBytes) {
            try {
              request.abort();
            } catch {
              // ignore
            }
            fail(
              new AppError(
                "PARSE",
                `响应体超过 ${maxResponseBytes} 字节上限，已中止读取`,
                {
                  retryable: false,
                  context: { limit: maxResponseBytes },
                },
              ),
            );
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          cleanup();
          const body = Buffer.concat(chunks);
          const location = response.headers?.location;
          resolve({
            status: response.statusCode,
            text: async () => body.toString("utf8"),
            json: async () => JSON.parse(body.toString("utf8")),
            location: Array.isArray(location) ? location[0] : location,
          });
        });
        response.on("error", fail);
      });
      request.on("error", (error) => {
        if (blockedAuth) {
          fail(authFailure());
          return;
        }
        if (blockedRedirect) {
          fail(
            new AppError("NETWORK", "重定向目标不在允许的官方端点内，已停止读取", {
              retryable: false,
            }),
          );
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (proxyChallengeSeen && /ERR_TOO_MANY_RETRIES|ERR_TUNNEL_CONNECTION_FAILED/i.test(message)) {
          fail(credentials ? authFailure() : authRequired());
          return;
        }
        fail(error);
      });
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
    async create(jobId: number, proxy: ProxySpec, limits?: JobLimits): Promise<JobSession> {
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
            hostname: parsed.hostname,
            port: parsed.port,
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
      const maxResponseBytes = limits?.maxResponseBytes ?? DEFAULT_JOB_BUDGETS.maxResponseBytes;
      return {
        transport: createTransport(isolated, credentials, maxResponseBytes),
        proxy: proxySnapshot(proxy),
        resolveProxy: (url: string) => isolated.resolveProxy(url),
      };
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
