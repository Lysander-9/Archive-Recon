"""PR #1 acceptance: T3 index time selection and source parsing (offline)."""

import unittest
from datetime import datetime
from unittest import mock

import pr1_support as support

import api_client
from api_client import ArchiveAPIClient, APIError


class FixedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2025, 9, 15)


class PeriodSelectionTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(api_client, "datetime", FixedDateTime)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = ArchiveAPIClient()
        self.client._collinfo_cache = support.load_json("cc_collinfo.json")

    def test_recent_months_formula(self):
        self.assertEqual(
            self.client.get_indexes_for_period(months=3),
            ["CC-MAIN-2025-38", "CC-MAIN-2025-30", "CC-MAIN-2025-26"],
        )

    def test_specific_year_month_formula(self):
        self.assertEqual(
            self.client.get_indexes_for_period(from_year=2024, from_month=10),
            ["CC-MAIN-2024-38"],
        )

    def test_all_time_returns_every_index(self):
        ids = [item["id"] for item in support.load_json("cc_collinfo.json")]
        self.assertEqual(self.client.get_indexes_for_period(), ids)

    def test_unverified_month_approximation_is_documented_as_such(self):
        # Guard: PR #1 does not change the week-number approximation.  The
        # assertion only pins current behaviour; it is not coverage proof.
        result = self.client.get_indexes_for_period(from_year=2024, from_month=10)
        self.assertEqual(result, ["CC-MAIN-2024-38"])


class SourceParsingTests(unittest.TestCase):
    def test_wayback_fixture_parsing_and_pagination_metadata(self):
        client = ArchiveAPIClient()
        transport = support.attach_transport(
            client,
            support.FakeResponse(json_data=support.load_json("wayback_page_0.json")),
        )
        result = client.query_wayback("example.com", page=0, page_size=5)

        self.assertEqual(len(result["results"]), 5)
        self.assertTrue(result["has_more"])
        self.assertEqual(result["results"][0]["timestamp"], "2024-01-02")
        self.assertEqual(result["results"][0]["source"], "wayback")
        self.assertIn("matchType=domain", transport.urls[0])
        self.assertIn("collapse=urlkey", transport.urls[0])

    def test_common_crawl_fixture_parsing_and_server_page_count(self):
        client = ArchiveAPIClient()
        transport = support.attach_transport(
            client, support.FakeResponse(text=support.load_text("cc_page_0.ndjson"))
        )
        result = client.query_commoncrawl(
            "CC-MAIN-TEST", "example.com", page=0, page_size=5, total_pages=3
        )

        self.assertEqual(len(result["results"]), 4)
        self.assertTrue(result["has_more"])
        self.assertIn("pageSize=5", transport.urls[0])

    def test_malformed_line_has_no_incompleteness_signal(self):
        client = ArchiveAPIClient()
        support.attach_transport(
            client, support.FakeResponse(text=support.load_text("cc_page_0.ndjson"))
        )
        result = client.query_commoncrawl(
            "CC-MAIN-TEST", "example.com", page=0, page_size=5, total_pages=1
        )

        # One line is deliberately malformed in the fixture.  PR #1 still
        # silently skips it and exposes no dropped-line/completeness field.
        self.assertEqual(len(result["results"]), 4)
        self.assertNotIn("dropped_lines", result)
        self.assertNotIn("completeness", result)


class RetryTests(unittest.TestCase):
    class TimeoutSession:
        def __init__(self):
            self.calls = 0

        def get(self, url, timeout=None):
            self.calls += 1
            import requests

            raise requests.Timeout("synthetic")

    def test_retry_budget_is_bounded(self):
        client = ArchiveAPIClient(max_retries=2)
        session = self.TimeoutSession()
        client.session = session

        with mock.patch("api_client.time.sleep", return_value=None):
            with self.assertRaises(APIError):
                client._request_with_retry("https://example.invalid/")

        self.assertEqual(session.calls, 2)


if __name__ == "__main__":
    unittest.main()
