"""Offline-only helpers shared by the NEPT-3 acceptance suite.

Policy: no test or helper in this directory may reach the network.  All HTTP
interaction is replaced at ``ArchiveAPIClient._request_with_retry``, and every
fixture under ``acceptance/fixtures`` is synthetic (see its README).
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def load_json(name: str):
    with open(FIXTURES / name, encoding="utf-8") as handle:
        return json.load(handle)


def load_text(name: str) -> str:
    with open(FIXTURES / name, encoding="utf-8") as handle:
        return handle.read()


class FakeResponse:
    """Minimal stand-in for ``requests.Response`` used by the client only."""

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
    """Callable replacement for ``_request_with_retry`` that records URLs.

    Responses are replayed in order; the last response is reused when the
    client asks for more requests than supplied.
    """

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
    """Entry-like widget: ``get``/``set``/``delete`` only."""

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
    """Widget stand-in that records ``configure`` calls and status text."""

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


class FakeProgress(FakeSink):
    pass


class FakeTable:
    """Results-table stand-in for GUI-state tests."""

    def __init__(self):
        self.all_results: list = []
        self.append_calls: list[list] = []
        self.empty_messages: list[str] = []
        self.current_page = 0

    def append_results(self, rows):
        self.append_calls.append(list(rows))
        self.all_results.extend(rows)

    def set_results(self, rows):
        self.all_results = list(rows)

    def set_empty_message(self, message):
        self.empty_messages.append(message)

    def _refresh_view(self):
        pass


def make_table(records=None, page_size: int = 20):
    """Build a real ``ResultsTable`` without creating Tk widgets.

    Only the attributes exercised by data/export methods are present; view
    refresh and dropdown refresh are replaced by recording stubs.
    """
    from main import ResultsTable

    table = ResultsTable.__new__(ResultsTable)
    table.source_name = "wayback"
    table.all_results = list(records or [])
    table.filtered_results = list(records or [])
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
    table.refresh_count = 0
    table.dropdown_count = 0
    table._update_domain_dropdown = lambda: setattr(
        table, "dropdown_count", table.dropdown_count + 1
    )
    table._refresh_view = lambda: setattr(table, "refresh_count", table.refresh_count + 1)
    table._update_heading_arrows = lambda: None
    return table


def make_fake_app(active_query_id: int = 1):
    """Build a real ``ArchiveSearchApp`` without creating a window.

    Enough state is present to exercise the task-lifecycle callbacks that do
    not touch Tk widgets directly.
    """
    from main import ArchiveSearchApp

    app = ArchiveSearchApp.__new__(ArchiveSearchApp)
    app._active_query_id = active_query_id
    app._stop_event = threading.Event()
    app.progress = FakeProgress()
    app.lbl_status = FakeSink()
    app.lbl_cc_indexes = FakeSink()
    app.cc_table = FakeTable()
    app.wayback_table = FakeTable()
    app.cc_querying = False
    app.cc_current_page = 0
    app.cc_index_ids = []
    app.cc_page_size = 5
    app.cc_failed_indexes = []
    app.cc_succeeded_indexes = []
    app.cc_truncated_indexes = []
    app.done_calls = 0
    app.load_calls = []
    app.batch_calls = []
    app.finished_calls = []
    app.error_calls = []
    app._query_done = lambda: setattr(app, "done_calls", app.done_calls + 1)
    app._load_cc_page = lambda domain=None: app.load_calls.append(domain)
    app._on_wayback_batch = lambda batch, page, count: app.batch_calls.append(
        (list(batch), page, count)
    )
    app._on_wayback_done = lambda total, domain, reached=False: app.finished_calls.append(
        (total, domain, reached)
    )
    app._on_query_error = lambda message: app.error_calls.append(message)
    app.after = lambda delay, callback: callback()
    return app


def record(
    url: str,
    status_code: str = "200",
    length: str = "100",
    file_type: str = "text/html",
    timestamp: str = "2024-01-02",
    source: str = "wayback",
) -> dict:
    return {
        "url": url,
        "status_code": status_code,
        "length": length,
        "file_type": file_type,
        "timestamp": timestamp,
        "source": source,
    }
