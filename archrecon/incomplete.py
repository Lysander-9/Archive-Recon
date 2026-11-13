"""不完整结果的结构化原因。

来源客户端在“结果仍可用、但有数据被跳过或未取完”时返回这些原因，
界面据此把“部分完成/截断/解析丢行”如实展示，而不是伪装成完整成功。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping


class IncompleteCode(str, Enum):
    """不完整原因类别。"""

    PARSE_LINE = "parse_line"
    PARSE_RECORD = "parse_record"
    NETWORK = "network"
    PAGE_LIMIT = "page_limit"
    RECORD_LIMIT = "record_limit"
    STOPPED = "stopped"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class IncompleteReason:
    """一条可展示的不完整原因。"""

    code: IncompleteCode
    message: str
    source: str | None = None
    index_id: str | None = None
    page: int | None = None
    count: int = 0
    retryable: bool = False
    context: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code.value,
            "message": self.message,
            "source": self.source,
            "index_id": self.index_id,
            "page": self.page,
            "count": self.count,
            "retryable": self.retryable,
            "context": dict(self.context),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "IncompleteReason":
        return cls(
            code=IncompleteCode(data.get("code", IncompleteCode.UNKNOWN.value)),
            message=str(data.get("message", "")),
            source=data.get("source"),
            index_id=data.get("index_id"),
            page=data.get("page"),
            count=int(data.get("count", 0) or 0),
            retryable=bool(data.get("retryable", False)),
            context=dict(data.get("context") or {}),
        )

    def describe(self) -> str:
        """单行摘要，供状态栏或原因列表使用。"""
        prefix = f"[{self.code.value}]"
        if self.index_id:
            prefix += f" {self.index_id}"
        if self.page is not None:
            prefix += f" 第{self.page + 1}页"
        if self.count:
            prefix += f" {self.count} 条"
        return f"{prefix} {self.message}".strip()


def summarize_reasons(reasons: list[Mapping[str, Any]] | None) -> str:
    """把原因列表压缩成一行摘要；空列表返回空串。"""
    if not reasons:
        return ""
    parsed = [IncompleteReason.from_dict(item) for item in reasons]
    total = sum(item.count for item in parsed)
    parts = [parsed[0].describe()]
    if len(parsed) > 1:
        parts.append(f"等 {len(parsed)} 项")
    if total:
        parts.append(f"共 {total} 条")
    return "；".join(parts)
