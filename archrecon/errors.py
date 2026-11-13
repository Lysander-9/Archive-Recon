"""统一错误类型。

内部异常不直接作为用户提示：调用方根据 ``ErrorCode`` 决定展示文案，
``context`` 用于记录来源、索引或文件名等排查信息，不含代理凭据。
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Mapping


class ErrorCode(str, Enum):
    """错误类别，供界面区分提示与是否可重试。"""

    INPUT = "input"
    NETWORK = "network"
    RESPONSE = "response"
    PARSE = "parse"
    EXPORT = "export"
    INTERNAL = "internal"


class AppError(Exception):
    """带类别的应用错误。"""

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        source: str | None = None,
        retryable: bool = False,
        context: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = ErrorCode(code)
        self.message = message
        self.source = source
        self.retryable = retryable
        self.context = dict(context or {})

    def __str__(self) -> str:
        return self.message

    def __repr__(self) -> str:
        return (
            f"AppError(code={self.code.value!r}, message={self.message!r}, "
            f"source={self.source!r}, retryable={self.retryable!r})"
        )
