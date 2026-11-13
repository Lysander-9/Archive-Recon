/** Application errors and terminal-state helpers. */

import type { AppErrorDto, ErrorCode, JobStatus, SourceId } from "../contracts/types";
import { TERMINAL_STATUSES } from "../contracts/types";

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
    super(message);
    this.name = "AppError";
    this.code = code;
    this.source = options.source;
    this.retryable = options.retryable ?? false;
    this.context = options.context;
  }

  toDto(): AppErrorDto {
    return {
      code: this.code,
      message: this.message,
      source: this.source,
      retryable: this.retryable,
      context: this.context,
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
    return new AppError("TIMEOUT", `请求超时：${message}`, { source, retryable: true });
  }
  return new AppError("NETWORK", `请求失败：${message}`, { source, retryable: true });
}
