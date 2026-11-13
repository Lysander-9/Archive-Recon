"""导出实现：CSV / JSON 固定五个数据字段，原子写入。

兼容既有导出契约（基线 ``8e6aaf9`` 实测输出）：
- CSV 使用 UTF-8 BOM（``utf-8-sig``），表头顺序 ``timestamp,status_code,length,file_type,url``；
- JSON 为对象数组，``ensure_ascii=False``、两空格缩进；
- 只导出上述五个字段，界面行号 ``#``、内部 ``source`` / ``raw_timestamp`` 不导出；
- 导出内容由调用方传入的筛选快照决定，不受当前分页影响。

写入时先写同目录临时文件再 ``os.replace``，失败不会留下半成品文件或覆盖原文件。
"""

from __future__ import annotations

import csv
import json
import os
import tempfile
from typing import Iterable, Mapping, Sequence

from .errors import AppError, ErrorCode
from .models import EXPORT_COLUMNS, ArchiveRecord


def rows_from_records(records: Iterable[ArchiveRecord]) -> list[dict[str, str]]:
    """把记录集合转换为导出行。"""
    return [record.to_export_row() for record in records]


def _ordered_row(row: Mapping[str, object]) -> dict[str, object]:
    return {column: row.get(column, "") for column in EXPORT_COLUMNS}


def _atomic_text_write(filepath: str, write_body, *, encoding: str, newline: str | None) -> None:
    target = os.path.abspath(os.fspath(filepath))
    directory = os.path.dirname(target) or os.curdir
    suffix = os.path.splitext(target)[1] or ".tmp"
    handle_fd = -1
    temp_path = ""
    try:
        handle_fd, temp_path = tempfile.mkstemp(prefix=".archrecon-", suffix=suffix, dir=directory)
        open_kwargs: dict[str, object] = {"encoding": encoding}
        if newline is not None:
            open_kwargs["newline"] = newline
        with os.fdopen(handle_fd, "w", **open_kwargs) as handle:
            handle_fd = -1
            write_body(handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
        temp_path = ""
    except OSError as error:
        raise AppError(
            ErrorCode.EXPORT,
            f"写入文件失败：{error}",
            retryable=False,
            context={"path": target},
        ) from error
    finally:
        if handle_fd >= 0:
            os.close(handle_fd)
        if temp_path and os.path.exists(temp_path):
            try:
                os.unlink(temp_path)
            except OSError:
                pass


def write_csv(rows: Sequence[Mapping[str, object]], filepath: str) -> int:
    """写出 CSV，返回记录条数（不含表头）。"""
    payload = [_ordered_row(row) for row in rows]

    def _write(handle) -> None:
        writer = csv.DictWriter(handle, fieldnames=list(EXPORT_COLUMNS))
        writer.writeheader()
        for row in payload:
            writer.writerow(row)

    _atomic_text_write(filepath, _write, encoding="utf-8-sig", newline="")
    return len(payload)


def write_json(rows: Sequence[Mapping[str, object]], filepath: str) -> int:
    """写出 JSON 数组，返回记录条数。"""
    payload = [_ordered_row(row) for row in rows]

    def _write(handle) -> None:
        json.dump(payload, handle, ensure_ascii=False, indent=2)

    _atomic_text_write(filepath, _write, encoding="utf-8", newline=None)
    return len(payload)
