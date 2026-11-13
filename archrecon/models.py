"""核心数据模型。

本模块只依赖标准库，GUI 与离线测试共用。记录字段与既有导出契约保持一致：
导出固定为五个数据字段 ``timestamp,status_code,length,file_type,url``，
顺序见 ``EXPORT_COLUMNS``；界面另有行号列 ``#``，内部 ``source`` 与
``raw_timestamp`` 字段只用于程序内部，不进入导出。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

#: 导出字段顺序，必须与基线 CSV / JSON 输出一致；界面行号列 ``#`` 不导出。
EXPORT_COLUMNS = ("timestamp", "status_code", "length", "file_type", "url")

#: 界面结果表格的数据列（渲染时在最前面额外加一列行号 ``#``）。
DISPLAY_COLUMNS = EXPORT_COLUMNS

_ALIASES = {
    "file_type": ("file_type", "mimetype", "mime", "content_type"),
    "status_code": ("status_code", "statuscode", "status"),
    "length": ("length", "size"),
    "timestamp": ("timestamp", "ts"),
    "url": ("url", "original", "urlkey"),
    "source": ("source",),
    "raw_timestamp": ("raw_timestamp",),
}


def _text(value: Any) -> str:
    """把外部值安全地转换为展示用字符串，None 视为空串。"""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def _pick(mapping: Mapping[str, Any], field: str) -> Any:
    for key in _ALIASES.get(field, (field,)):
        if key in mapping:
            value = mapping[key]
            if value is not None:
                return value
    return None


@dataclass(frozen=True)
class ArchiveRecord:
    """单条存档记录。

    ``timestamp`` 为展示格式（``YYYY-MM-DD``），与既有导出兼容；
    ``raw_timestamp`` 保留来源返回的原始时间戳（如 ``YYYYMMDDHHMMSS``），
    便于后续按需提供更精确的时间，不改变现有界面与导出。
    """

    url: str
    status_code: str = ""
    length: str = ""
    file_type: str = ""
    timestamp: str = ""
    source: str = ""
    raw_timestamp: str = ""

    def __post_init__(self) -> None:
        for field_name in ("url", "status_code", "length", "file_type",
                           "timestamp", "source", "raw_timestamp"):
            value = getattr(self, field_name)
            if not isinstance(value, str):
                object.__setattr__(self, field_name, _text(value))

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> "ArchiveRecord":
        """从来源客户端返回的字典构造记录（兼容旧字段名）。"""
        if isinstance(data, ArchiveRecord):
            return data
        return cls(
            url=_text(_pick(data, "url")),
            status_code=_text(_pick(data, "status_code")),
            length=_text(_pick(data, "length")),
            file_type=_text(_pick(data, "file_type")),
            timestamp=_text(_pick(data, "timestamp")),
            source=_text(_pick(data, "source")),
            raw_timestamp=_text(_pick(data, "raw_timestamp")),
        )

    def to_export_row(self) -> dict[str, str]:
        """导出用行数据，列顺序与 ``EXPORT_COLUMNS`` 一致。"""
        return {column: getattr(self, column, "") for column in EXPORT_COLUMNS}

    def value_of(self, column: str) -> str:
        """读取任意界面列的值，未知列返回空串。"""
        return getattr(self, column, "") if column else ""

    def to_mapping(self) -> dict[str, str]:
        """包含来源等附加字段的完整字典，供界面或日志使用。"""
        return {
            "url": self.url,
            "status_code": self.status_code,
            "length": self.length,
            "file_type": self.file_type,
            "timestamp": self.timestamp,
            "source": self.source,
            "raw_timestamp": self.raw_timestamp,
        }
