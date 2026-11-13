"""T3 acceptance: index time selection and incomplete-result reporting.

The baseline selects Common Crawl indexes by treating the crawl sequence
number in ``CC-MAIN-YYYY-NN`` as an ISO week number.  That arithmetic is
asserted here as observed behaviour / regression guard only -- it is NOT a
verified statement about the real time coverage of an index.  Source-contract
verification remains an open item (see ACCEPTANCE_CHECKLIST.md, T3-1).
"""

import unittest
from datetime import datetime
from unittest import mock

import support

import api_client
import main
from api_client import ArchiveAPIClient, APIError


class FixedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2025, 9, 15)


class YearBoundaryDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2025, 1, 15)


class PeriodSelectionTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(api_client, "datetime", FixedDateTime)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = ArchiveAPIClient()
        self.client._collinfo_cache = support.load_json("cc_collinfo.json")

    def test_recent_months_uses_observed_week_to_month_formula(self):
        self.assertEqual(
            self.client.get_indexes_for_period(months=3),
            ["CC-MAIN-2025-38", "CC-MAIN-2025-30", "CC-MAIN-2025-26"],
        )

    def test_recent_months_across_a_year_boundary(self):
        with mock.patch.object(api_client, "datetime", YearBoundaryDateTime):
            self.assertEqual(
                self.client.get_indexes_for_period(months=3),
                [
                    "CC-MAIN-2025-38",
                    "CC-MAIN-2025-30",
                    "CC-MAIN-2025-26",
                    "CC-MAIN-2025-18",
                    "CC-MAIN-2025-13",
                    "CC-MAIN-2025-10",
                    "CC-MAIN-2025-05",
                    "CC-MAIN-2024-51",
                    "CC-MAIN-2024-43",
                    "CC-MAIN-2024-38",
                ],
            )

    def test_specific_year_month_at_a_year_boundary(self):
        self.assertEqual(
            self.client.get_indexes_for_period(from_year=2023, from_month=12),
            ["CC-MAIN-2023-50"],
        )

    def test_specific_year_month_selects_by_sequence_formula(self):
        # 2024-38 is selected for "2024-10" because (38 - 1) // 4 + 1 == 10.
        # This does not prove CC-MAIN-2024-38 covers October 2024.
        self.assertEqual(
            self.client.get_indexes_for_period(from_year=2024, from_month=10),
            ["CC-MAIN-2024-38"],
        )

    def test_specific_year_month_with_no_match_is_empty(self):
        self.assertEqual(
            self.client.get_indexes_for_period(from_year=2019, from_month=1), []
        )

    def test_all_time_returns_every_index_in_source_order(self):
        ids = [item["id"] for item in support.load_json("cc_collinfo.json")]
        self.assertEqual(self.client.get_indexes_for_period(), ids)

    def test_year_only_filter_is_a_substring_match_on_the_id(self):
        result = self.client.get_indexes_for_period(from_year=2024)
        self.assertEqual(len(result), 11)
        self.assertTrue(all(item.startswith("CC-MAIN-2024-") for item in result))


class ServerPageMetadataTests(unittest.TestCase):
    def test_page_count_comes_from_service_metadata(self):
        client = ArchiveAPIClient()
        support.attach_transport(
            client, support.FakeResponse(json_data=support.load_json("cc_page_count.json"))
        )

        pages = client.get_commoncrawl_page_count("CC-MAIN-TEST", "example.com")

        self.assertEqual(pages, 3)

    def test_malformed_page_count_is_a_bounded_error(self):
        client = ArchiveAPIClient()
        support.attach_transport(client, support.FakeResponse(json_data=[]))

        with self.assertRaises(APIError):
            client.get_commoncrawl_page_count("CC-MAIN-TEST", "example.com")

    def test_has_more_follows_page_count_not_record_count(self):
        client = ArchiveAPIClient()
        support.attach_transport(
            client, support.FakeResponse(text=support.load_text("cc_page_0.ndjson"))
        )

        # Four valid rows are returned although page_size is 5; the service
        # says three pages exist, so more pages must still be requested.
        result = client.query_commoncrawl(
            "CC-MAIN-TEST", "example.com", page=0, page_size=5, total_pages=3
        )

        self.assertEqual(len(result["results"]), 4)
        self.assertTrue(result["has_more"])


class PartialResultStateTests(unittest.TestCase):
    """T3: one failed index must not discard the other indexes' records."""

    def test_one_of_three_indexes_failing_keeps_other_results(self):
        app = support.make_fake_app()
        app.cc_index_ids = ["CC-MAIN-A", "CC-MAIN-B", "CC-MAIN-C"]

        main_a = support.record("https://example.com/a")
        main_b = support.record("https://example.com/b")
        main.ArchiveSearchApp._on_cc_page_done(
            app, "CC-MAIN-A", [main_a], 1, total_pages=1, pages_fetched=1
        )
        main.ArchiveSearchApp._on_cc_page_done(
            app, "CC-MAIN-B", [main_b], 1, total_pages=1, pages_fetched=1
        )
        main.ArchiveSearchApp._on_cc_page_error(
            app, "CC-MAIN-C", "synthetic failure", 1, None
        )

        self.assertEqual(
            [row["url"] for row in app.cc_table.all_results],
            ["https://example.com/a", "https://example.com/b"],
        )
        self.assertEqual(len(app.cc_failed_indexes), 1)
        self.assertIn("部分完成", app.lbl_status.text)
        self.assertIn("1 个索引失败", app.lbl_status.text)
        self.assertIn("CC-MAIN-C", app.lbl_cc_indexes.text)
        self.assertEqual(app.done_calls, 1)

    def test_all_indexes_failing_reports_failure(self):
        app = support.make_fake_app()
        app.cc_index_ids = ["CC-MAIN-A"]

        main.ArchiveSearchApp._on_cc_page_error(
            app, "CC-MAIN-A", "synthetic failure", 1, None
        )

        self.assertEqual(app.cc_table.all_results, [])
        self.assertIn("查询失败", app.lbl_status.text)
        self.assertEqual(app.done_calls, 1)
        self.assertTrue(app.cc_table.empty_messages)

    def test_page_cap_is_reported_as_incomplete(self):
        app = support.make_fake_app()
        app.cc_index_ids = ["CC-MAIN-A"]

        main.ArchiveSearchApp._on_cc_page_done(
            app,
            "CC-MAIN-A",
            [support.record("https://example.com/a")],
            1,
            total_pages=7,
            pages_fetched=5,
        )

        self.assertIn("部分完成", app.lbl_status.text)
        self.assertIn("5 页上限", app.lbl_status.text)
        self.assertEqual(app.cc_truncated_indexes, ["CC-MAIN-A"])
        self.assertIn("CC-MAIN-A", app.lbl_cc_indexes.text)

    def test_partial_records_from_failed_page_are_retained(self):
        app = support.make_fake_app()
        app.cc_index_ids = ["CC-MAIN-A"]

        main.ArchiveSearchApp._on_cc_page_error(
            app,
            "CC-MAIN-A",
            "synthetic failure",
            1,
            [support.record("https://example.com/partial")],
        )

        self.assertEqual(len(app.cc_table.all_results), 1)
        self.assertIn("部分完成", app.lbl_status.text)
        self.assertTrue(app.cc_table.empty_messages)


if __name__ == "__main__":
    unittest.main()
