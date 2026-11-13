/** Proxy configuration: validated once per task, never silently downgraded to direct. */

import type { ProxySnapshot, ProxySpec } from "../../contracts/types";
import { AppError } from "../../application/errors";

export interface ElectronProxyConfig {
  mode: "direct" | "system" | "fixed_servers";
  proxyRules?: string;
  proxyBypassRules?: string;
}

const PROXY_SERVER = /^(https?|socks5):\/\/[^\s/]+$/i;

export function buildProxyConfig(spec: ProxySpec): ElectronProxyConfig {
  if (spec.mode === "direct") return { mode: "direct" };
  if (spec.mode === "system") return { mode: "system" };
  const server = (spec.server ?? "").trim();
  if (!server || !PROXY_SERVER.test(server)) {
    throw new AppError("PROXY", "代理地址无效，已停止任务；不会回退为直连", {
      retryable: false,
    });
  }
  return { mode: "fixed_servers", proxyRules: server };
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
  return { mode: "fixed", server, display: `固定代理 ${redactProxy(server)}` };
}
