/** HTTP helpers on top of an injected transport (Electron net in production). */

import { AppError } from "../../application/errors";
import { DEFAULT_JOB_BUDGETS } from "../../application/budgets";
import type { RequestOptions, Transport } from "../../application/ports";

export interface TextResponse {
  status: number;
  text: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [750, 2000];

function abortError(): AppError {
  return new AppError("CLOSED", "请求已取消");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function httpMessage(status: number, body: string): string {
  const extra = snippet(body) ? `（${snippet(body)}）` : "";
  if (status === 407) return "代理认证失败（HTTP 407）：请检查代理用户名/密码";
  if (status === 401) return "来源要求认证（HTTP 401）";
  if (status === 429) return "来源限流（HTTP 429），请稍后重试";
  if (status === 502) return "来源网关错误（HTTP 502）";
  if (status === 503) return "来源服务不可用（HTTP 503）";
  if (status === 504) return "来源网关超时（HTTP 504）";
  if (status === 400) return `来源拒绝了该请求（HTTP 400）${extra}`;
  if (status === 404) return `来源没有该索引或页面（HTTP 404）${extra}`;
  return `来源返回 HTTP ${status}${extra}`;
}

function classifyTransportError(message: string): { kind: string; text: string; retryable: boolean } {
  if (/ERR_PROXY|ERR_TUNNEL|ERR_NO_SUPPORTED_PROXIES|ERR_MANDATORY_PROXY/i.test(message)) {
    return {
      kind: "proxy",
      text: `代理连接失败（${message}）：请确认代理地址/端口与认证，当前任务不会回退直连`,
      retryable: false,
    };
  }
  if (/ERR_NAME|ERR_DNS|ERR_NAME_NOT_RESOLVED/i.test(message)) {
    return {
      kind: "dns",
      text: `域名解析失败（${message}）：请检查 DNS 或代理的远端解析`,
      retryable: false,
    };
  }
  if (/ERR_CERT|ERR_SSL|ERR_BAD_SSL|ERR_TLS/i.test(message)) {
    return {
      kind: "tls",
      text: `TLS/证书校验失败（${message}）：请检查系统时间、代理或上游证书`,
      retryable: false,
    };
  }
  if (/TIMED_OUT|TIMEOUT|ERR_TIMED|timed out|ETIMEDOUT/i.test(message)) {
    return {
      kind: "timeout",
      text: `请求超时（${message}）：代理或上游响应过慢`,
      retryable: false,
    };
  }
  const transient = /ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_NETWORK_CHANGED|ERR_HTTP2/i.test(
    message,
  );
  return {
    kind: "network",
    text: `网络请求失败（${message}）`,
    retryable: transient,
  };
}

export async function fetchText(
  transport: Transport,
  url: string,
  options: RequestOptions,
): Promise<TextResponse> {
  if (options.signal.aborted) throw abortError();
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = (): void => controller.abort();
  options.signal.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, options.timeoutMs));
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  try {
    let currentUrl = url;
    let attempts = 0;
    for (let hop = 0; hop <= 5; hop += 1) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        attempts += 1;
        let response;
        try {
          response = await transport(currentUrl, {
            signal: controller.signal,
            onRedirect: options.validateRedirect,
          });
        } catch (error) {
          if (options.signal.aborted) throw abortError();
          if (timedOut) {
            throw new AppError("TIMEOUT", `请求超时（${Math.round(options.timeoutMs / 1000)} 秒）`, {
              retryable: true,
              context: { stage: "transport", attempts, kind: "timeout", timeoutMs: options.timeoutMs },
            });
          }
          if (error instanceof AppError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          const classified = classifyTransportError(message);
          if (classified.retryable && attempt < MAX_ATTEMPTS - 1) {
            await sleep(retryDelays[Math.min(attempt, retryDelays.length - 1)], options.signal);
            continue;
          }
          throw new AppError("NETWORK", classified.text, {
            retryable: classified.retryable,
            context: { stage: "transport", attempts, kind: classified.kind, netError: message },
          });
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.location;
          if (!location) {
            throw new AppError("NETWORK", "重定向响应缺少目标地址，已停止读取", {
              context: { stage: "redirect", attempts },
            });
          }
          let next: string;
          try {
            next = new URL(location, currentUrl).toString();
          } catch {
            throw new AppError("NETWORK", "重定向目标无法解析，已停止读取", {
              context: { stage: "redirect", attempts },
            });
          }
          if (options.validateRedirect && !options.validateRedirect(next)) {
            throw new AppError("NETWORK", "重定向目标不在允许的官方端点内，已停止读取", {
              context: { stage: "redirect", attempts },
            });
          }
          currentUrl = next;
          break;
        }

        const text = await response.text();
        if (response.status >= 400) {
          const failure = new AppError("NETWORK", httpMessage(response.status, text), {
            retryable: RETRYABLE_STATUSES.has(response.status),
            context: {
              stage: "http",
              attempts,
              kind: "http",
              httpStatus: response.status,
              bodySnippet: snippet(text),
            },
          });
          if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
            await sleep(retryDelays[Math.min(attempt, retryDelays.length - 1)], options.signal);
            continue;
          }
          throw failure;
        }

        const limit = options.maxResponseBytes ?? DEFAULT_JOB_BUDGETS.maxResponseBytes;
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > limit) {
          throw new AppError("PARSE", `响应体超过 ${limit} 字节上限，已中止读取`, {
            retryable: false,
            context: { stage: "body", attempts, kind: "budget", bytes, limit },
          });
        }
        return { status: response.status, text };
      }
    }
    throw new AppError("NETWORK", "重定向次数过多，已停止读取", {
      context: { stage: "redirect", attempts },
    });
  } catch (error) {
    if (options.signal.aborted) throw abortError();
    if (timedOut) {
      throw new AppError("TIMEOUT", `请求超时（${Math.round(options.timeoutMs / 1000)} 秒）`, {
        retryable: true,
        context: { stage: "transport", kind: "timeout", timeoutMs: options.timeoutMs },
      });
    }
    if (error instanceof AppError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError("NETWORK", `请求失败：${message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onParentAbort);
  }
}

export function buildUrl(base: string, path: string, params?: Record<string, string>): string {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  if (params) {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  }
  return url.toString();
}
