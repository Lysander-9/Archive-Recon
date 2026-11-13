"""Archive-Recon 核心层（与 GUI 无关）。

``main.py`` 只通过本包操作数据模型、结果集合、任务状态与导出；离线回归测试
也可以直接导入，无需安装 customtkinter / requests。
"""

from .collection import AppendOutcome, ResultCollection
from .errors import AppError, ErrorCode
from .exporter import rows_from_records, write_csv, write_json
from .filters import FilterSpec, SortSpec, apply_filter, next_sort_state, sort_key, sort_records
from .incomplete import IncompleteCode, IncompleteReason, summarize_reasons
from .jobs import (
    DATA_STATUSES,
    TERMINAL_STATUSES,
    InvalidJobTransition,
    JobCoordinator,
    JobEvent,
    JobStatus,
    QueryJob,
)
from .matching import (
    INTERESTING_PATTERNS,
    extract_hostname,
    is_interesting_url,
    match_domain_pattern,
    match_domain_patterns,
    normalize_patterns,
    split_terms,
    strip_domain_count_suffix,
)
from .models import DISPLAY_COLUMNS, EXPORT_COLUMNS, ArchiveRecord
from .validation import DomainTarget, normalize_domain, parse_domain

__all__ = [
    "AppendOutcome",
    "ArchiveRecord",
    "AppError",
    "DATA_STATUSES",
    "DISPLAY_COLUMNS",
    "DomainTarget",
    "ErrorCode",
    "EXPORT_COLUMNS",
    "FilterSpec",
    "INTERESTING_PATTERNS",
    "IncompleteCode",
    "IncompleteReason",
    "InvalidJobTransition",
    "JobCoordinator",
    "JobEvent",
    "JobStatus",
    "QueryJob",
    "ResultCollection",
    "SortSpec",
    "TERMINAL_STATUSES",
    "apply_filter",
    "extract_hostname",
    "is_interesting_url",
    "match_domain_pattern",
    "match_domain_patterns",
    "next_sort_state",
    "normalize_domain",
    "normalize_patterns",
    "parse_domain",
    "rows_from_records",
    "sort_key",
    "sort_records",
    "split_terms",
    "strip_domain_count_suffix",
    "summarize_reasons",
    "write_csv",
    "write_json",
]
