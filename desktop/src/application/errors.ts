/** Application errors and terminal-state helpers. */

import { sanitizeContext, sanitizePublicText } from "./sanitize";
import { TERMINAL_STATUSES, type AppErrorDto, type ErrorCode, type JobStatus, type SourceId } from "../contracts/types";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly source?: SourceId;
  readonly retryable: boolean;
  readonly context?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: {
    source?: SourceId;
    retryable?: boolean;
    context?: Record<string, unknown>;
  } = {}) {
    super(sanitizePublicText(message));
    this.name = "AppError";
    this.code = code;
    this.source = options.source;
    this.retryable = options.retryable ?? false;
    this.context = options.context;
  }

  toDto(): AppErrorDto {
    return {
      code: this.code,
      message: sanitizePublicText(this.message),
      source: this.source,
      retryable: this.retryable,
      context: sanitizeContext(this.context),
    };
  }
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function errorFromUnknown(error: unknown, source?: SourceId): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AppError("CLOSED", "请求已取消", { source });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|AbortSignal\.timeout/i.test(message)) {
    return new AppError("TIMEOUT", "请求超时", { source, retryable: true, context: { kind: "timeout" } });
  }
  const code = /\bnet::ERR_[A-Z0-9_]+\b/i.exec(message)?.[0];
  return new AppError("NETWORK", code ? `请求失败（${code}）` : "请求失败（未分类的错误）", {
    source, retryable: false, context: code ? { netError: code } : undefined,
  });
}
