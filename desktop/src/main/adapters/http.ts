/** HTTP helpers on top of an injected transport (Electron session.fetch in production). */

import { AppError } from "../../application/errors";
import { DEFAULT_JOB_BUDGETS } from "../../application/budgets";
import type { RequestOptions, Transport } from "../../application/ports";

export interface TextResponse {
  status: number;
  text: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function abortError(): AppError {
  return new AppError("CLOSED", "请求已取消");
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

  try {
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await transport(currentUrl, {
        signal: controller.signal,
        onRedirect: options.validateRedirect,
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.location;
        if (!location) {
          throw new AppError("NETWORK", "重定向响应缺少目标地址，已停止读取");
        }
        let next: string;
        try {
          next = new URL(location, currentUrl).toString();
        } catch {
          throw new AppError("NETWORK", "重定向目标无法解析，已停止读取");
        }
        if (options.validateRedirect && !options.validateRedirect(next)) {
          throw new AppError("NETWORK", "重定向目标不在允许的官方端点内，已停止读取");
        }
        currentUrl = next;
        continue;
      }

      const text = await response.text();
      const limit = options.maxResponseBytes ?? DEFAULT_JOB_BUDGETS.maxResponseBytes;
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > limit) {
        throw new AppError("PARSE", `响应体超过 ${limit} 字节上限，已中止读取`, {
          retryable: false,
          context: { bytes, limit },
        });
      }
      if (response.status >= 400) {
        throw new AppError("NETWORK", `HTTP ${response.status}`, { retryable: response.status >= 500 });
      }
      return { status: response.status, text };
    }
    throw new AppError("NETWORK", "重定向次数过多，已停止读取");
  } catch (error) {
    if (options.signal.aborted) throw abortError();
    if (timedOut) {
      throw new AppError("TIMEOUT", "请求超时", { retryable: true });
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
