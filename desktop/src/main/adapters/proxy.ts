/** Proxy configuration: validated once per task, never silently downgraded to direct. */

import type { ProxySnapshot, ProxySpec } from "../../contracts/types";
import { AppError } from "../../application/errors";

export interface ElectronProxyConfig {
  mode: "direct" | "system" | "fixed_servers";
  proxyRules?: string;
  proxyBypassRules?: string;
}

export type ProxyProtocol = "http:" | "https:" | "socks5:";

export interface ParsedProxyServer {
  /** Origin without credentials, e.g. "http://127.0.0.1:8080". */
  baseServer: string;
  protocol: ProxyProtocol;
  hostname: string;
  port: string;
  username?: string;
  password?: string;
  hasCredentials: boolean;
}

const SCHEME_ONLY = /^(https?|socks5):\/\/[^\s/@?#]+$/i;
function proxyError(message: string): AppError {
  return new AppError("PROXY", `${message}；不会回退为直连`, { retryable: false });
}

/** Parse one fixed proxy URL, separating credentials from the proxy rules value. */
export function parseProxyServer(server: string): ParsedProxyServer {
  const value = (server ?? "").trim();
  if (!value) throw proxyError("代理地址为空");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw proxyError("代理地址无法解析");
  }
  if (!/^(https?|socks5):$/i.test(url.protocol)) {
    throw proxyError("代理协议只支持 http、https 或 socks5");
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw proxyError("代理地址不能包含路径");
  }
  if (url.search || url.hash) throw proxyError("代理地址不能包含查询参数或片段");
  if (!url.hostname) throw proxyError("代理地址缺少主机名");
  if (!url.port) throw proxyError("代理地址缺少端口");

  const username = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  if ((username && !password) || (!username && password)) {
    throw proxyError("代理认证需要同时提供用户名和密码");
  }
  const protocol = url.protocol.toLowerCase() as ProxyProtocol;
  return {
    baseServer: `${protocol}//${url.host}`,
    protocol,
    hostname: url.hostname,
    port: url.port,
    username,
    password,
    hasCredentials: Boolean(username && password),
  };
}

export function buildProxyConfig(spec: ProxySpec): ElectronProxyConfig {
  if (spec.mode === "direct") return { mode: "direct" };
  if (spec.mode === "system") return { mode: "system" };
  const server = (spec.server ?? "").trim();
  if (!server) throw proxyError("代理地址为空");
  // Validate and strip credentials: proxy rules handed to Chromium must never
  // carry userinfo (it is answered through the app login event instead).
  const parsed = parseProxyServer(server);
  return { mode: "fixed_servers", proxyRules: parsed.baseServer };
}

export function redactProxy(server: string): string {
  try {
    const url = new URL(server);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "已配置代理（地址无法解析）";
  }
}

export function proxySnapshot(spec: ProxySpec): ProxySnapshot {
  if (spec.mode === "direct") return { mode: "direct", display: "直连" };
  if (spec.mode === "system") return { mode: "system", display: "系统代理" };
  const server = (spec.server ?? "").trim();
  const redacted = redactProxy(server);
  return { mode: "fixed", server: redacted, display: `固定代理 ${redacted}` };
}
