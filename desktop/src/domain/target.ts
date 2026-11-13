/** Strict target normalization: host and subdomains, "*.example.com" is an alias. */

import type { TargetScope } from "../contracts/types";
import { domainToASCII } from "node:url";

export interface TargetFailure {
  ok: false;
  message: string;
}

export type TargetResult = { ok: true; scope: TargetScope } | TargetFailure;

const WHITESPACE = /\s/u;

function invalid(message: string): TargetFailure {
  return { ok: false, message };
}

export function normalizeTarget(input: string): TargetResult {
  let value = typeof input === "string" ? input.trim() : "";
  if (!value) return invalid("请输入目标域名后再开始查询。");
  if (WHITESPACE.test(value)) return invalid("域名中不能包含空白字符，请检查后重试。");
  // Reject illegal host representations before any URL parsing: percent-encoding,
  // backslashes and control characters must never reach the network layer.
  if (/%/.test(value)) return invalid("域名中不能包含百分号编码等非法字符，请直接输入域名。");
  if (/[\u0000-\u001F\u007F\\]/.test(value)) {
    return invalid("域名格式无效，请输入 example.com 或 *.example.com。");
  }
  if (value.includes("@")) return invalid("请移除用户信息（user:pass@），只输入域名。");

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(value);
  if (scheme) {
    if (!/^https?$/i.test(scheme[1])) return invalid("域名格式无效，请输入 example.com 或 *.example.com。");
    value = value.slice(scheme[0].length);
  }

  let wildcard = false;
  if (value.startsWith("*.")) {
    wildcard = true;
    value = value.slice(2);
  }

  if (/[?#]/.test(value)) return invalid("这里只接受域名，不接受路径、查询参数或片段。");

  const slashIndex = value.indexOf("/");
  if (slashIndex >= 0) {
    if (slashIndex !== value.length - 1) {
      return invalid("这里只接受域名，不接受路径、查询参数或片段。");
    }
    value = value.slice(0, slashIndex);
  }

  if (value.includes("[") || value.includes("]")) {
    return invalid("域名格式无效，请输入 example.com 或 *.example.com。");
  }

  const portMatch = /^(.*):([^:]*)$/.exec(value);
  if (portMatch) {
    const port = portMatch[2];
    if (!/^\d+$/.test(port)) return invalid("端口格式无效；查询目标请只填写域名。");
    return invalid("请移除端口号，只输入域名，例如 example.com。");
  }

  if (!value) return invalid("域名格式无效，请输入 example.com 或 *.example.com。");

  const host = value.toLowerCase();
  if (host.includes("*")) return invalid("域名格式无效，请输入 example.com 或 *.example.com。");
  if (host.includes("_")) return invalid("域名格式无效，请检查各级域名标签。");
  if (host.length > 253) return invalid("域名格式无效，请检查各级域名标签。");

  const asciiHost = /^[\x00-\x7F]*$/.test(host) ? host : domainToASCII(host);
  if (!asciiHost) return invalid("域名中包含无效字符，请检查后重试。");

  const labels = asciiHost.split(".");
  const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  for (const label of labels) {
    if (!LABEL.test(label)) return invalid("域名格式无效，请检查各级域名标签。");
  }

  return {
    ok: true,
    scope: {
      host: asciiHost,
      wildcard,
      match: "host-and-subdomains",
      label: wildcard ? `*.${asciiHost}` : asciiHost,
    },
  };
}
