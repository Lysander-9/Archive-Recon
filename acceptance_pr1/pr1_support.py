"""Helpers for the independent acceptance run against PR #1 (commit 6349a0e).

These helpers are intentionally separate from ``acceptance/support.py``: PR #1
moved result state into ``archrecon`` and changed callback signatures, so the
baseline harness cannot be reused unchanged.  Assertions are not weakened --
the same T1-T6 contract is exercised against the new interfaces.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
import sys

# Point this harness at the checkout under test.  Defaults to the repository
# that contains this directory; set ARCHRECON_ROOT when running it from a
# separate PR #1 extraction.
ROOT = Path(
    os.environ.get("ARCHRECON_ROOT") or Path(__file__).resolve().parents[1]
).resolve()
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def load_text(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def load_json(name: str):
    return json.loads(load_text(name))


class FakeResponse:
    def __init__(self, *, status_code: int = 200, text: str = "", json_data=None):
        self.status_code = status_code
        self.text = text
        self._json_data = json_data

    def json(self):
        return self._json_data

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests

            raise requests.HTTPError(f"HTTP {self.status_code}")


class Transport:
    def __init__(self, responses):
        self._responses = list(responses)
        self.urls: list[str] = []

    def __call__(self, url: str):
        self.urls.append(url)
        index = min(len(self.urls) - 1, len(self._responses) - 1)
        item = self._responses[index]
        if isinstance(item, Exception):
            raise item
        return item


def attach_transport(client, *responses) -> Transport:
    transport = Transport(responses)
    client._request_with_retry = transport
    return transport


class FakeEntry:
    def __init__(self, value: str = ""):
        self.value = value

    def get(self) -> str:
        return self.value

    def set(self, value: str) -> None:
        self.value = value

    def delete(self, first, last=None) -> None:
        self.value = ""


class FakeVar:
    def __init__(self, value=False):
        self.value = value

    def get(self):
        return self.value

    def set(self, value) -> None:
        self.value = value


class FakeSink:
    def __init__(self):
        self.calls: list[dict] = []
        self.last: dict = {}

    def configure(self, **kwargs):
        self.calls.append(kwargs)
        self.last = kwargs

    @property
    def text(self):
        return self.last.get("text", "")

    def set(self, value) -> None:
        self.calls.append({"set": value})

    def stop(self) -> None:
        self.calls.append({"stop": True})

    def start(self) -> None:
        self.calls.append({"start": True})


class FakeTable:
    """Table replacement backed by a real ResultCollection."""

    def __init__(self):
        from archrecon import ResultCollection

        self.collection = ResultCollection()
        self.current_page = 0
        self.empty_messages: list[str] = []

    def append_results(self, rows):
        return self.collection.append(rows)

    def set_results(self, rows):
        self.collection.reset(rows)
        self.current_page = 0

    def set_empty_message(self, message):
        self.empty_messages.append(message)

    def _refresh_view(self):
        pass


class FakeSelector:
    def __init__(self, params=None):
        self.params = params or {"months": 3}

    def get_query_params(self):
        return dict(self.params)


def make_table(records=None, *, source_name="wayback", page_size=20):
    """Real ResultsTable without Tk; collection-backed like PR #1."""
    from archrecon import ResultCollection
    import main

    table = main.ResultsTable.__new__(main.ResultsTable)
    table.source_name = source_name
    table.collection = ResultCollection(records or (), source_name=source_name)
    table.page_size = page_size
    table.current_page = 0
    table.sort_column = None
    table.sort_reverse = False
    table.current_font_size = 11
    table.empty_message = "no data"
    table.filter_status = FakeEntry("")
    table.filter_mime = FakeEntry("")
    table.filter_url = FakeEntry("")
    table.filter_domain = FakeEntry("")
    table.interesting_only = FakeVar(False)
    table._update_domain_dropdown = lambda: None
    table._refresh_view = lambda: None
    table._update_heading_arrows = lambda: None
    return table


def make_app(initial_domain="example.com"):
    """Real ArchiveSearchApp without Tk, with a live JobCoordinator."""
    import main
    from archrecon import JobCoordinator

    app = main.ArchiveSearchApp.__new__(main.ArchiveSearchApp)
    app.jobs = JobCoordinator()
    job = app.jobs.start("wayback")
    app._current_job = job
    app._stop_event = job.stop_event
    app.progress = FakeSink()
    app.lbl_status = FakeSink()
    app.lbl_cc_indexes = FakeSink()
    app.cc_table = FakeTable()
    app.wayback_table = FakeTable()
    app.entry_domain = FakeEntry(initial_domain)
    app.tabview = FakeSink()
    app.cc_time_selector = FakeSelector()
    app.cc_querying = False
    app.cc_current_page = 0
    app.cc_index_ids = []
    app.cc_page_size = 5
    app.cc_failed_indexes = []
    app.cc_succeeded_indexes = []
    app.cc_truncated_indexes = []
    app.done_calls = []
    app.load_calls = []
    app.error_calls = []
    app.after = lambda delay, callback: callback()
    app._query_done = lambda job_id=None: app.done_calls.append(job_id)
    app._load_cc_page = lambda domain=None, job_id=None: app.load_calls.append(
        (domain, job_id)
    )
    app._on_query_error = lambda message: app.error_calls.append(message)
    return app, job


def record(url, status="200", length="100", file_type="text/html",
           timestamp="2024-01-02", source="wayback"):
    return {
        "url": url,
        "status_code": status,
        "length": length,
        "file_type": file_type,
        "timestamp": timestamp,
        "source": source,
    }
