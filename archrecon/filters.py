"""结果筛选与排序（纯函数）。

筛选语义与原界面一致，支持逗号分隔的多值与 ``!`` 前缀排除：
- 状态码：精确匹配字符串；
- 文件类型 / URL 关键词：不区分大小写的子串匹配；
- 域名：根域自动包含子域，``*.`` 前缀等价；
- 敏感路径模式：命中即保留。

筛选与排序返回新列表，绝不修改调用方传入的记录集合。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

from .matching import (
    is_interesting_url,
    match_domain_patterns,
    split_terms,
    strip_domain_count_suffix,
)
from .models import ArchiveRecord

INT_SORT_COLUMNS = ("status_code", "length")


@dataclass(frozen=True)
class FilterSpec:
    """一次筛选的全部条件；空字符串表示该条件不生效。"""

    status: str = ""
    file_type: str = ""
    url_keyword: str = ""
    domain: str = ""
    interesting_only: bool = False

    def is_active(self) -> bool:
        return bool(
            self.status.strip()
            or self.file_type.strip()
            or self.url_keyword.strip()
            or self.domain.strip()
            or self.interesting_only
        )

    def describe(self) -> dict:
        """便于日志或界面展示的条件快照。"""
        return {
            "status": self.status,
            "file_type": self.file_type,
            "url_keyword": self.url_keyword,
            "domain": self.domain,
            "interesting_only": self.interesting_only,
        }


@dataclass(frozen=True)
class SortSpec:
    """排序条件，``column`` 为空表示保持原始顺序。"""

    column: str | None = None
    reverse: bool = False

    def is_active(self) -> bool:
        return bool(self.column)


def _status_filter(records: Iterable[ArchiveRecord], raw: str) -> list[ArchiveRecord]:
    includes, excludes = split_terms(raw)
    include_codes = set(includes)
    exclude_codes = set(excludes)
    result = list(records)
    if include_codes:
        result = [record for record in result if record.status_code in include_codes]
    if exclude_codes:
        result = [record for record in result if record.status_code not in exclude_codes]
    return result


def _substring_filter(records: Iterable[ArchiveRecord], raw: str, field: str) -> list[ArchiveRecord]:
    includes, excludes = split_terms(raw)
    include_terms = [term.lower() for term in includes]
    exclude_terms = [term.lower() for term in excludes]
    result = list(records)
    if include_terms:
        result = [
            record for record in result
            if all(term in record.value_of(field).lower() for term in include_terms)
        ]
    if exclude_terms:
        result = [
            record for record in result
            if not any(term in record.value_of(field).lower() for term in exclude_terms)
        ]
    return result


def _domain_filter(records: Iterable[ArchiveRecord], raw: str) -> list[ArchiveRecord]:
    includes, excludes = split_terms(strip_domain_count_suffix(raw))
    if not includes and not excludes:
        return list(records)
    return [
        record for record in records
        if match_domain_patterns(record.url, [p.lower() for p in includes], [p.lower() for p in excludes])
    ]


def apply_filter(records: Sequence[ArchiveRecord], spec: FilterSpec | None = None) -> list[ArchiveRecord]:
    """按条件过滤记录，返回新列表；``spec`` 为空时返回浅拷贝。"""
    filtered = list(records)
    if spec is None or not spec.is_active():
        return filtered

    if spec.status.strip():
        filtered = _status_filter(filtered, spec.status)
    if spec.file_type.strip():
        filtered = _substring_filter(filtered, spec.file_type, "file_type")
    if spec.url_keyword.strip():
        filtered = _substring_filter(filtered, spec.url_keyword, "url")
    if spec.domain.strip():
        filtered = _domain_filter(filtered, spec.domain)
    if spec.interesting_only:
        filtered = [record for record in filtered if is_interesting_url(record.url)]
    return filtered


def sort_key(record: ArchiveRecord, column: str):
    """与原实现一致的排序键：数值列按整数，其余按小写字符串。"""
    value = record.value_of(column)
    if column in INT_SORT_COLUMNS:
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0
    return str(value).lower()


def sort_records(records: Sequence[ArchiveRecord], spec: SortSpec | None = None) -> list[ArchiveRecord]:
    """按条件排序，返回新列表，不修改原始集合。"""
    result = list(records)
    if spec is None or not spec.is_active():
        return result
    result.sort(key=lambda record: sort_key(record, spec.column), reverse=spec.reverse)
    return result


def next_sort_state(column: str, current_column: str | None, current_reverse: bool) -> SortSpec:
    """点击表头时的排序切换规则：同列反转，换列则升序。"""
    if current_column == column:
        return SortSpec(column=column, reverse=not current_reverse)
    return SortSpec(column=column, reverse=False)
