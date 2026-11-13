"""结果集合：唯一 URL 记录、筛选视图、排序视图与导出快照。

设计要点：
- ``records`` 是原始集合，按接收顺序保存，去重后不再改变顺序；
- 筛选与排序只作用于派生视图（``view``），原始集合不受影响；
- ``append`` 重新应用当前筛选与排序，因此追加数据不会重置用户条件；
- ``snapshot`` 返回当前视图的导出快照，保证导出内容与筛选结果一致。

去重规则：按完整 URL 字符串精确比较，保留首批出现的记录（首条保留）。
不同协议、路径或查询参数视为不同 URL；空 URL 不参与去重，避免静默丢数据。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

from .filters import FilterSpec, SortSpec, apply_filter, sort_records
from .models import ArchiveRecord


@dataclass(frozen=True)
class AppendOutcome:
    """一次追加的统计结果。"""

    added: int = 0
    duplicates: int = 0
    batch_duplicates: int = 0
    known_duplicates: int = 0
    total: int = 0

    def summary(self) -> str:
        return f"+{self.added} 条，跳过 {self.duplicates} 条重复，共 {self.total} 条"


class ResultCollection:
    """某个来源的唯一 URL 结果集合。"""

    def __init__(
        self,
        records: Iterable[ArchiveRecord | Mapping[str, Any]] | None = None,
        *,
        source_name: str = "",
    ) -> None:
        self.source_name = source_name
        self._records: list[ArchiveRecord] = []
        self._urls: set[str] = set()
        self._filter = FilterSpec()
        self._sort = SortSpec()
        self._view_cache: tuple[ArchiveRecord, ...] | None = None
        self.reset(records or ())

    # ==================== 读取 ====================

    @property
    def records(self) -> tuple[ArchiveRecord, ...]:
        """原始集合（去重后、按接收顺序）。"""
        return tuple(self._records)

    @property
    def filter_spec(self) -> FilterSpec:
        return self._filter

    @property
    def sort_spec(self) -> SortSpec:
        return self._sort

    @property
    def total_count(self) -> int:
        return len(self._records)

    @property
    def view(self) -> tuple[ArchiveRecord, ...]:
        """当前筛选 + 排序后的视图。"""
        if self._view_cache is None:
            filtered = apply_filter(self._records, self._filter)
            self._view_cache = tuple(sort_records(filtered, self._sort))
        return self._view_cache

    @property
    def view_count(self) -> int:
        return len(self.view)

    def __len__(self) -> int:
        return len(self._records)

    def __iter__(self):
        return iter(self._records)

    def page(self, page_index: int, page_size: int) -> list[ArchiveRecord]:
        """按偏移切分当前视图；页码越界时返回空列表。"""
        if page_index < 0 or page_size <= 0:
            return []
        start = page_index * page_size
        return list(self.view[start:start + page_size])

    def page_count(self, page_size: int) -> int:
        if page_size <= 0:
            return 1
        total = self.view_count
        return max(1, (total - 1) // page_size + 1) if total else 1

    def snapshot(self) -> list[dict[str, str]]:
        """导出快照：当前筛选与排序下的全部记录，与界面可见顺序一致。"""
        return [record.to_export_row() for record in self.view]

    def urls(self) -> tuple[str, ...]:
        """原始集合中的非空 URL（供测试与诊断使用）。"""
        return tuple(record.url for record in self._records if record.url)

    # ==================== 变更 ====================

    def clear(self) -> None:
        """清空所有记录，保留筛选与排序条件。"""
        self._records = []
        self._urls = set()
        self._invalidate()

    def reset(self, records: Iterable[ArchiveRecord | Mapping[str, Any]]) -> None:
        """替换全部记录并重新去重；筛选与排序条件保持不变。"""
        self._records = []
        self._urls = set()
        self.append(records)

    def append(self, records: Iterable[ArchiveRecord | Mapping[str, Any]]) -> AppendOutcome:
        """追加一批记录，同批与跨批重复的 URL 只保留首条。"""
        added = 0
        batch_duplicates = 0
        known_duplicates = 0
        batch_keys: set[str] = set()
        for item in records or ():
            record = item if isinstance(item, ArchiveRecord) else ArchiveRecord.from_mapping(item)
            key = record.url
            if key:
                if key in batch_keys:
                    batch_duplicates += 1
                    continue
                if key in self._urls:
                    known_duplicates += 1
                    continue
                batch_keys.add(key)
                self._urls.add(key)
            self._records.append(record)
            added += 1
        if added:
            self._invalidate()
        return AppendOutcome(
            added=added,
            duplicates=batch_duplicates + known_duplicates,
            batch_duplicates=batch_duplicates,
            known_duplicates=known_duplicates,
            total=len(self._records),
        )

    def apply_filter(self, spec: FilterSpec | None) -> int:
        """设置筛选条件并返回匹配数量。"""
        self._filter = spec or FilterSpec()
        self._invalidate()
        return self.view_count

    def clear_filter(self) -> int:
        return self.apply_filter(FilterSpec())

    def set_sort(self, column: str | None, reverse: bool = False) -> int:
        """设置排序条件并返回当前视图数量。"""
        self._sort = SortSpec(column=column, reverse=reverse)
        self._invalidate()
        return self.view_count

    def clear_sort(self) -> None:
        self.set_sort(None, False)

    # ==================== 内部 ====================

    def _invalidate(self) -> None:
        self._view_cache = None

    def __repr__(self) -> str:  # pragma: no cover - 调试辅助
        return (
            f"ResultCollection(source={self.source_name!r}, "
            f"total={self.total_count}, view={self.view_count})"
        )
