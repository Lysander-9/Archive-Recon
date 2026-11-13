"""任务生命周期与事件归属。

一次查询对应一个 :class:`QueryJob`。任务编号单调递增，所有后台回调都必须
带上 ``job_id``；:class:`JobCoordinator` 只接受当前任务的事件，旧任务（已停止、
已失败或被新任务取代）的迟到事件一律丢弃，避免停止后重启时串数据。

状态转换是单向的：终态（completed / partial / failed / stopped）不再接收数据，
也不再允许转换。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Mapping

import threading


class JobStatus(str, Enum):
    PREPARING = "preparing"
    RUNNING = "running"
    STOPPING = "stopping"
    COMPLETED = "completed"
    PARTIAL = "partial"
    FAILED = "failed"
    STOPPED = "stopped"


TERMINAL_STATUSES = frozenset({
    JobStatus.COMPLETED,
    JobStatus.PARTIAL,
    JobStatus.FAILED,
    JobStatus.STOPPED,
})

DATA_STATUSES = frozenset({
    JobStatus.PREPARING,
    JobStatus.RUNNING,
    JobStatus.STOPPING,
})

_ALLOWED_TRANSITIONS: dict[JobStatus, frozenset[JobStatus]] = {
    JobStatus.PREPARING: frozenset({
        JobStatus.PREPARING, JobStatus.RUNNING, JobStatus.STOPPING,
        JobStatus.COMPLETED, JobStatus.PARTIAL, JobStatus.FAILED, JobStatus.STOPPED,
    }),
    JobStatus.RUNNING: frozenset({
        JobStatus.RUNNING, JobStatus.STOPPING,
        JobStatus.COMPLETED, JobStatus.PARTIAL, JobStatus.FAILED, JobStatus.STOPPED,
    }),
    JobStatus.STOPPING: frozenset({
        JobStatus.STOPPING, JobStatus.STOPPED,
        JobStatus.PARTIAL, JobStatus.FAILED, JobStatus.COMPLETED,
    }),
    JobStatus.COMPLETED: frozenset({JobStatus.COMPLETED}),
    JobStatus.PARTIAL: frozenset({JobStatus.PARTIAL}),
    JobStatus.FAILED: frozenset({JobStatus.FAILED}),
    JobStatus.STOPPED: frozenset({JobStatus.STOPPED}),
}


class InvalidJobTransition(RuntimeError):
    """非法的任务状态转换。"""


@dataclass(eq=False)
class QueryJob:
    """一次查询任务。"""

    job_id: int
    source: str
    status: JobStatus = JobStatus.PREPARING
    received_count: int = 0
    unique_count: int = 0
    completeness: str = "unknown"
    reason: str = ""
    started_at: datetime = field(default_factory=datetime.now)
    finished_at: datetime | None = None
    stop_event: threading.Event = field(default_factory=threading.Event, repr=False)

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES

    @property
    def accepts_data(self) -> bool:
        return self.status in DATA_STATUSES

    def transition(self, status: JobStatus | str, reason: str = "") -> JobStatus:
        """转换状态；非法转换抛出 :class:`InvalidJobTransition`。"""
        target = JobStatus(status)
        if target not in _ALLOWED_TRANSITIONS[self.status]:
            raise InvalidJobTransition(
                f"任务 {self.job_id} 不允许从 {self.status.value} 转换到 {target.value}"
            )
        self.status = target
        if reason:
            self.reason = reason
        if target in TERMINAL_STATUSES:
            self.finished_at = datetime.now()
            self.stop_event.set()
        return target

    def mark_running(self) -> None:
        if self.status is JobStatus.PREPARING:
            self.transition(JobStatus.RUNNING)

    def request_stop(self) -> None:
        """请求停止：立即置位取消事件，状态进入 stopping。"""
        if self.is_terminal:
            self.stop_event.set()
            return
        self.stop_event.set()
        if self.status is not JobStatus.STOPPING:
            self.transition(JobStatus.STOPPING)

    def finish(self, status: JobStatus | str, reason: str = "") -> JobStatus:
        """结束任务；已处于终态时保持原状态，不覆盖已有结果。"""
        target = JobStatus(status)
        if target not in TERMINAL_STATUSES:
            raise InvalidJobTransition(f"{target.value} 不是终态")
        if self.is_terminal:
            return self.status
        if target is JobStatus.COMPLETED and self.completeness == "partial":
            target = JobStatus.PARTIAL
        return self.transition(target, reason)

    def note_batch(self, received: int, unique_total: int | None = None) -> None:
        """记录一批已接收数据；只有当前任务仍可接收时才应调用。"""
        self.received_count += max(0, int(received))
        if unique_total is not None:
            self.unique_count = max(0, int(unique_total))
        if self.status is JobStatus.PREPARING:
            self.mark_running()

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "source": self.source,
            "status": self.status.value,
            "received_count": self.received_count,
            "unique_count": self.unique_count,
            "completeness": self.completeness,
            "reason": self.reason,
            "started_at": self.started_at.isoformat(timespec="seconds"),
            "finished_at": self.finished_at.isoformat(timespec="seconds") if self.finished_at else None,
        }


@dataclass(frozen=True)
class JobEvent:
    """后台线程提交的事件；``job_id`` 用于校验归属。"""

    job_id: int
    kind: str
    payload: Mapping[str, Any] = field(default_factory=dict)


class JobCoordinator:
    """任务登记与事件归属校验。"""

    def __init__(self) -> None:
        self._jobs: dict[int, QueryJob] = {}
        self._active_id: int = 0
        self._next_id: int = 0

    @property
    def active_job(self) -> QueryJob | None:
        return self._jobs.get(self._active_id)

    @property
    def active_job_id(self) -> int:
        return self._active_id

    def get(self, job_id: int) -> QueryJob | None:
        return self._jobs.get(job_id)

    def start(self, source: str) -> QueryJob:
        """开始新任务；未结束的旧任务被标记为 stopped（被取代）。"""
        previous = self.active_job
        if previous is not None and not previous.is_terminal:
            previous.finish(JobStatus.STOPPED, "被新任务取代")

        self._next_id += 1
        job = QueryJob(job_id=self._next_id, source=source)
        self._jobs[job.job_id] = job
        self._active_id = job.job_id
        return job

    def accepts(self, job_id: int | None) -> bool:
        """事件是否属于当前任务。"""
        return job_id is not None and job_id == self._active_id and self._active_id in self._jobs

    def accepts_data(self, job_id: int | None) -> bool:
        """当前任务是否还能接收数据（未结束、未被取代）。"""
        if not self.accepts(job_id):
            return False
        job = self._jobs[self._active_id]
        return job.accepts_data

    def finish_active(self, status: JobStatus | str, reason: str = "") -> QueryJob | None:
        job = self.active_job
        if job is None:
            return None
        job.finish(status, reason)
        return job
