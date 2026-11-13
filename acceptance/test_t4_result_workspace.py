"""T4 acceptance: result workspace data semantics (offline, no Tk window).

The real ``ResultsTable`` methods are exercised on an instance created with
``__new__``; only view refresh/dropdown refresh are replaced with recording
stubs.  Criteria covered: same-batch and cross-batch URL uniqueness, filters
surviving incremental appends, clear-filter behaviour, filter reset of the
page index, and sorting the full filtered set rather than the visible page.
"""

import unittest

import support

import main


def urls(records):
    return [item["url"] for item in records]


class DedupeTests(unittest.TestCase):
    def test_set_results_keeps_first_record_per_url(self):
        first = support.record("https://example.com/a", "200")
        duplicate = support.record("https://example.com/a", "301")
        other = support.record("https://example.com/b", "200")
        table = support.make_table()

        table.set_results([first, duplicate, other])

        self.assertEqual(urls(table.all_results), ["https://example.com/a", "https://example.com/b"])
        self.assertEqual(table.all_results[0]["status_code"], "200")
        self.assertEqual(table.filtered_results, table.all_results)

    def test_set_results_ignores_records_without_url(self):
        table = support.make_table()

        table.set_results(
            [support.record(""), support.record("https://example.com/ok")]
        )

        self.assertEqual(urls(table.all_results), ["https://example.com/ok"])

    def test_append_dedupes_against_already_stored_urls(self):
        original = support.record("https://example.com/a", "200")
        duplicate = support.record("https://example.com/a", "301")
        new = support.record("https://example.com/b", "200")
        table = support.make_table([original])

        table.append_results([duplicate, new])

        self.assertEqual(
            urls(table.all_results),
            ["https://example.com/a", "https://example.com/b"],
        )
        self.assertEqual(table.all_results[0]["status_code"], "200")

    def test_append_deduplicates_within_the_new_batch(self):
        first = support.record("https://example.com/b", "200")
        duplicate = support.record("https://example.com/b", "301")
        other = support.record("https://example.com/c", "200")
        table = support.make_table()

        table.append_results([first, duplicate, other])

        self.assertEqual(
            urls(table.all_results),
            ["https://example.com/b", "https://example.com/c"],
            "same-batch duplicates must not both enter the unique-URL result set",
        )


class FilterPersistenceTests(unittest.TestCase):
    def _filtered_table(self):
        table = support.make_table(
            [
                support.record("https://example.com/a", "200"),
                support.record("https://example.com/b", "301"),
                support.record("https://example.com/c", "200"),
            ]
        )
        table.filter_status.set("200")
        table._apply_filters()
        self.assertEqual(len(table.filtered_results), 2)
        return table

    def test_append_after_filter_keeps_all_visible_rows_matching(self):
        table = self._filtered_table()
        table.append_results(
            [
                support.record("https://example.com/d", "404"),
                support.record("https://example.com/e", "200"),
            ]
        )

        self.assertTrue(
            all(item["status_code"] == "200" for item in table.filtered_results),
            "appending data must not silently drop the active filter",
        )
        self.assertIn("https://example.com/e", urls(table.filtered_results))
        self.assertNotIn("https://example.com/d", urls(table.filtered_results))

    def test_clear_filters_restores_the_full_result_set(self):
        table = self._filtered_table()

        table._clear_filters()

        self.assertEqual(table.filtered_results, table.all_results)
        self.assertEqual(table.current_page, 0)
        self.assertEqual(table.filter_status.get(), "")
        self.assertFalse(table.interesting_only.get())

    def test_filter_resets_page_index(self):
        table = self._filtered_table()
        table.current_page = 3

        table.filter_status.set("301")
        table._apply_filters()

        self.assertEqual(table.current_page, 0)
        self.assertEqual(urls(table.filtered_results), ["https://example.com/b"])


class FilterSemanticsTests(unittest.TestCase):
    def setUp(self):
        self.table = support.make_table(
            [
                support.record("https://www.example.com/admin", "200", "100", "text/html"),
                support.record("https://cdn.example.com/app.js", "301", "200", "application/javascript"),
                support.record("https://example.com/.env", "403", "10", "text/plain"),
                support.record("https://other.com/a", "404", "0", "application/json"),
            ]
        )

    def test_status_include_and_exclude_lists(self):
        self.table.filter_status.set("200,301")
        self.table._apply_filters()
        self.assertEqual(len(self.table.filtered_results), 2)

        self.table.filter_status.set("!404")
        self.table._apply_filters()
        self.assertEqual(len(self.table.filtered_results), 3)

    def test_mime_is_fuzzy_and_excludable(self):
        self.table.filter_mime.set("application/")
        self.table._apply_filters()
        self.assertEqual(len(self.table.filtered_results), 2)

        self.table.filter_mime.set("!javascript")
        self.table._apply_filters()
        self.assertEqual(len(self.table.filtered_results), 3)

    def test_url_keyword_include_and_exclude(self):
        self.table.filter_url.set("admin")
        self.table._apply_filters()
        self.assertEqual(urls(self.table.filtered_results), ["https://www.example.com/admin"])

        self.table.filter_url.set("!cdn")
        self.table._apply_filters()
        self.assertEqual(len(self.table.filtered_results), 3)

    def test_domain_filter_strips_count_suffix_and_excludes(self):
        self.table.filter_domain.set("www.example.com (1)")
        self.table._apply_filters()
        self.assertEqual(urls(self.table.filtered_results), ["https://www.example.com/admin"])

        self.table.filter_domain.set("example.com,!cdn.example.com")
        self.table._apply_filters()
        self.assertEqual(
            urls(self.table.filtered_results),
            ["https://www.example.com/admin", "https://example.com/.env"],
        )

    def test_interesting_only_filter(self):
        self.table.interesting_only.set(True)
        self.table._apply_filters()
        # /admin matches the existing /admin/?$ pattern as well as .env.
        self.assertEqual(
            urls(self.table.filtered_results),
            ["https://www.example.com/admin", "https://example.com/.env"],
        )


class SortTests(unittest.TestCase):
    def test_sort_applies_to_entire_filtered_result_not_just_current_page(self):
        records = [
            support.record(f"https://example.com/{i}", str(200 + i % 50), str(1000 - i))
            for i in range(120)
        ]
        table = support.make_table(records, page_size=20)
        table.page_size = 20
        table.filtered_results = records[:70]
        table.current_page = 3

        table._sort_by_column("length")

        self.assertEqual(table.current_page, 0)
        self.assertEqual(len(table.filtered_results), 70)
        lengths = [int(item["length"]) for item in table.filtered_results]
        self.assertEqual(lengths, sorted(lengths))

        table._sort_by_column("length")
        lengths = [int(item["length"]) for item in table.filtered_results]
        self.assertEqual(lengths, sorted(lengths, reverse=True))


if __name__ == "__main__":
    unittest.main()
