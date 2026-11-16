/** Public-output sanitization: never expose credentials or raw unknown bodies. */

import type { ReasonDto } from "../contracts/types";

const HIDDEN_DETAILS = "（诊断详情已隐藏）";
// These patterns locate unstructured parameter blocks; they never guess where
// a secret value ends. Once found, the whole remaining block is excluded.
const SENSITIVE_PARAMETERS = /["']?\b(password|passwd|pwd|token|secret|api[_-]?key|authorization|proxy-authorization)["']?\s*[:=]|\b(Bearer|Basic)\s+/i;
const URL_USERINFO = /\/\/[^/@\s]+@/g;

/** Structured diagnostics are data, not trusted public message templates.
 * Hide complete objects/arrays without publishing any of their values. The
 * scanner understands JSON escapes so a quote/comma inside a string cannot
 * expose its suffix. Malformed or truncated structures fail closed.
 */
function hideStructuredDetails(text: string): string {
  let output = "";
  let cursor = 0;
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    output += text.slice(cursor, start) + HIDDEN_DETAILS;
    const stack = [text[start]];
    let quoted = false;
    let escaped = false;
    let end = text.length;
    for (let position = start + 1; position < text.length; position += 1) {
      const character = text[position];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{" || character === "[") stack.push(character);
      else if (character === "}" || character === "]") {
        const opening = stack.pop();
        if ((character === "}" && opening !== "{") || (character === "]" && opening !== "[")) break;
        if (stack.length === 0) { end = position + 1; break; }
      }
    }
    cursor = end;
    start = end - 1;
  }
  return output + text.slice(cursor);
}

export function sanitizePublicText(value: unknown): string {
  let text = hideStructuredDetails(String(value ?? ""));
  const parameterStart = text.search(SENSITIVE_PARAMETERS);
  if (parameterStart >= 0) text = text.slice(0, parameterStart) + HIDDEN_DETAILS;
  text = text.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  text = text.replace(URL_USERINFO, "//");
  return text.slice(0, 300);
}

export function sanitizeContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    // Only diagnostic fields with a known public shape may cross IPC. In
    // particular, nested causes, raw bodies and arbitrary extension keys must
    // not bypass text redaction through an object or an array.
    if (["attempts", "httpStatus", "timeoutMs", "limit", "bytes", "bodyBytes"].includes(key)) {
      if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    } else if (key === "stage" || key === "kind") {
      if (typeof value === "string" && /^[a-z][a-z0-9-]{0,40}$/i.test(value)) result[key] = value;
    } else if (key === "netError" && typeof value === "string") {
      const code = /\bnet::ERR_[A-Z0-9_]+\b/i.exec(value);
      if (code) result[key] = code[0];
    } else if (key === "lineNumbers" && Array.isArray(value)) {
      result[key] = value.filter((item) => Number.isSafeInteger(item) && item > 0).slice(0, 5);
    }
  }
  return result;
}

export function sanitizeReason(reason: ReasonDto): ReasonDto {
  return {
    ...reason,
    message: sanitizePublicText(reason.message),
    context: sanitizeContext(reason.context as Record<string, unknown> | undefined),
  };
}
