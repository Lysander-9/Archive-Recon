"""T2 acceptance: query lifecycle at the client/state-callback boundary.

Covers fixture-driven parsing and pagination, bounded retries, stop behaviour
(no further page is scheduled after stop), stale-event guards that already
exist, and completion messaging for capped result sets.

GUI window rendering is out of scope here; see ACCEPTANCE_CHECKLIST.md.
"""

import unittest
from unittest import mock
from urllib.parse import parse_qs, urlparse

import support

import main
from api_client import ArchiveAPIClient, APIError


class WaybackParsingTests(unittest.TestCase):
    def test_fixture_page_is_normalized(self):
        client = ArchiveAPIClient()
        support.attach_transport(
            client,
            support.FakeResponse(json_data=support.load_json("wayback_page_0.json")),
        )

        result = client.query_wayback("example.com", page=0, page_size=5)

        self.assertEqual(len(result["results"]), 5)
        self.assertTrue(result["has_more"])
        first = result["results"][0]
        self.assertEqual(first["url"], "https://example.com/")
        self.assertEqual(first["status_code"], "200")
        self.assertEqual(first["length"], "512")
        self.assertEqual(first["file_type"], "text/html")
        self.assertEqual(first["timestamp"], "2024-01-02")
        self.assertEqual(first["source"], "wayback")

    def test_second_page_requests_page_and_reports_no_more(self):
        client = ArchiveAPIClient()
        transport = support.attach_transport(
            client,
            support.FakeResponse(json_data=support.load_json("wayback_page_1.json")),
        )

        result = client.query_wayback("example.com", page=1, page_size=5)

        query = parse_qs(urlparse(transport.urls[0]).query, keep_blank_values=True)
        self.assertEqual(query["page"], ["1"])
        self.assertEqual(len(result["results"]), 2)
        self.assertFalse(result["has_more"])

    def test_empty_response_yields_no_records(self):
        client = ArchiveAPIClient()
        support.attach_transport(
            client, support.FakeResponse(json_data=support.load_json("wayback_empty.json"))
        )

        result = client.query_wayback("example.com", page=0, page_size=5)

        self.assertEqual(result["results"], [])
        self.assertEqual(result["total_available"], 0)
        self.assertFalse(result["has_more"])

    def test_timestamp_is_normalized_to_date_only_at_baseline(self):
        # Contract observed at the baseline: HHMMSS is dropped during
        # normalization, so exported "timestamp" is a date, not a snapshot time.
        client = ArchiveAPIClient()
        support.attach_transport(
            client,
            support.FakeResponse(json_data=support.load_json("wayback_page_0.json")),
        )

        result = client.query_wayback("example.com", page=0, page_size=5)

        self.assertEqual(result["results"][0]["timestamp"], "2024-01-02")


class CommonCrawlParsingTests(unittest.TestCase):
    def test_ndjson_fixture_is_normalized(self):
        client = ArchiveAPIClient()
        support.attach_transport(
            client, support.FakeResponse(text=support.load_text("cc_page_0.ndjson"))
        )

        result = client.query_commoncrawl(
            "CC-MAIN-TEST", "example.com", page=0, page_size=5, total_pages=3
        )

        self.assertEqual(len(result["results"]), 4)
        self.assertTrue(result["has_more"])
        first = result["results"][0]
        self.assertEqual(first["url"], "https://example.com/")
        self.assertEqual(first["status_code"], "200")
        self.assertEqual(first["length"], "512")
        self.assertEqual(first["file_type"], "text/html")
        self.assertEqual(first["timestamp"], "2024-01-02")
        self.assertEqual(first["source"], "commoncrawl")

    def test_second_page_has_more_follows_server_page_count(self):
        client = ArchiveAPIClient()
        transport = support.attach_transport(
            client, support.FakeResponse(text=support.load_text("cc_page_1.ndjson"))
        )

        result = client.query_commoncrawl(
            "CC-MAIN-TEST", "example.com", page=1, page_size=5, total_pages=2
        )

        query = parse_qs(urlparse(transport.urls[0]).query, keep_blank_values=True)
        self.assertEqual(query["page"], ["1"])
        self.assertEqual(len(result["results"]), 2)
        self.assertFalse(result["has_more"])

    def test_empty_response_yields_no_records(self):
        client = ArchiveAPIClient()
        support.attach_transport(client, support.FakeResponse(text=""))

        result = client.query_commoncrawl(
            "CC-MAIN-TEST", "example.com", page=0, page_size=5, total_pages=3
        )

        self.assertEqual(result["results"], [])
        self.assertTrue(result["has_more"])


class RetryTests(unittest.TestCase):
    class TimeoutSession:
        def __init__(self):
            self.calls = 0

        def get(self, url, timeout=None):
            self.calls += 1
            import requests

            raise requests.Timeout("synthetic timeout")

    class FlakySession:
        def __init__(self, responses):
            self.responses = list(responses)
            self.calls = 0

        def get(self, url, timeout=None):
            self.calls += 1
            return self.responses.pop(0)

    def test_retry_budget_is_bounded(self):
        client = ArchiveAPIClient(max_retries=2)
        session = self.TimeoutSession()
        client.session = session

        with mock.patch("api_client.time.sleep", return_value=None):
            with self.assertRaises(APIError) as caught:
                client._request_with_retry("https://example.invalid/")

        self.assertEqual(session.calls, 2)
        self.assertIn("2 retries", str(caught.exception))

    def test_429_is_retried_then_succeeds(self):
        ok = support.FakeResponse(json_data={"ok": True})
        session = self.FlakySession([support.FakeResponse(status_code=429), ok])
        client = ArchiveAPIClient(max_retries=3)
        client.session = session

        with mock.patch("api_client.time.sleep", return_value=None):
            response = client._request_with_retry("https://example.invalid/")

        self.assertIs(response, ok)
        self.assertEqual(session.calls, 2)


class StopAndStateCallbackTests(unittest.TestCase):
    def test_stop_prevents_further_wayback_pages(self):
        app = support.make_fake_app()
        calls = []

        class StoppingClient:
            def query_wayback(self, **kwargs):
                calls.append(kwargs["page"])
                app._stop_event.set()
                return {
                    "results": [support.record("https://example.com/1")],
                    "has_more": True,
                }

        app.client = StoppingClient()

        main.ArchiveSearchApp._do_wayback_query(app, "example.com")

        self.assertEqual(calls, [0], "a page was scheduled after stop was requested")
        self.assertEqual(len(app.batch_calls), 1)
        self.assertEqual(app.done_calls, 1)
        self.assertEqual(app.finished_calls, [])
        self.assertIn("已停止", app.lbl_status.text)

    def test_wayback_batch_appends_and_updates_status(self):
        app = support.make_fake_app()
        batch = [
            support.record("https://example.com/1"),
            support.record("https://example.com/2"),
        ]

        main.ArchiveSearchApp._on_wayback_batch(app, batch, 0, 2)

        self.assertEqual(len(app.wayback_table.all_results), 2)
        self.assertIn("2", app.lbl_status.text)

    def test_wayback_query_continues_until_has_more_is_false(self):
        app = support.make_fake_app()
        calls = []

        class Client:
            def query_wayback(self, **kwargs):
                page = kwargs["page"]
                calls.append(page)
                return {
                    "results": [support.record(f"https://example.com/{page}")],
                    "has_more": page < 2,
                }

        app.client = Client()

        with mock.patch("time.sleep", return_value=None):
            main.ArchiveSearchApp._do_wayback_query(app, "example.com")

        self.assertEqual(calls, [0, 1, 2])
        self.assertEqual(len(app.batch_calls), 3)
        self.assertEqual(app.finished_calls, [(3, "example.com", False)])

    def test_wayback_twentieth_page_with_more_is_marked_partial(self):
        app = support.make_fake_app()
        calls = []

        class Client:
            def query_wayback(self, **kwargs):
                calls.append(kwargs["page"])
                return {
                    "results": [support.record("https://example.com/x")],
                    "has_more": True,
                }

        app.client = Client()

        with mock.patch("time.sleep", return_value=None):
            main.ArchiveSearchApp._do_wayback_query(app, "example.com")

        self.assertEqual(len(calls), 20)
        self.assertEqual(app.finished_calls, [(20, "example.com", True)])

    def test_wayback_limit_marks_partial_completion(self):
        app = support.make_fake_app()

        main.ArchiveSearchApp._on_wayback_done(app, 1000, "example.com", True)

        self.assertIn("部分完成", app.lbl_status.text)
        self.assertIn("20 页", app.lbl_status.text)

    def test_common_crawl_stale_result_callback_is_ignored(self):
        app = support.make_fake_app(active_query_id=2)

        main.ArchiveSearchApp._on_cc_page_done(
            app, "CC-MAIN-OLD", [support.record("https://example.com/old")], 1, 1, 1
        )

        self.assertEqual(app.cc_table.all_results, [])
        self.assertEqual(app.done_calls, 0)

    def test_common_crawl_stale_index_callback_is_ignored(self):
        app = support.make_fake_app(active_query_id=2)
        app.cc_index_ids = ["CC-MAIN-NEW"]

        main.ArchiveSearchApp._on_cc_indexes_ready(app, 1, "example.com", ["CC-MAIN-OLD"])

        self.assertEqual(app.load_calls, [])
        self.assertEqual(app.lbl_status.calls, [])

    def test_common_crawl_stale_error_callback_is_ignored(self):
        app = support.make_fake_app(active_query_id=2)

        main.ArchiveSearchApp._on_cc_page_error(app, "CC-MAIN-OLD", "boom", 1, None)

        self.assertEqual(app.cc_failed_indexes, [])
        self.assertEqual(app.done_calls, 0)


if __name__ == "__main__":
    unittest.main()
