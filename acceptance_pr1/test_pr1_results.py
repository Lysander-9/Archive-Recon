"""PR #1 acceptance: T4 result workspace semantics."""

import unittest

import pr1_support as support

import main
from archrecon import FilterSpec, ResultCollection, SortSpec, apply_filter, sort_records


def rec(url, status="200", length="100", file_type="text/html", timestamp="2024-01-02"):
    return support.record(url, status, length, file_type, timestamp)


class CollectionDedupeTests(unittest.TestCase):
    def test_same_batch_duplicates_keep_first(self):
        collection = ResultCollection([
            rec("https://example.com/a", "200"),
            rec("https://example.com/a", "301"),
            rec("https://example.com/b", "200"),
        ])

        self.assertEqual(
            collection.urls(), ("https://example.com/a", "https://example.com/b")
        )
        self.assertEqual(collection.records[0].status_code, "200")

    def test_cross_batch_duplicates_keep_first(self):
        collection = ResultCollection([rec("https://example.com/a", "200")])
        outcome = collection.append([
            rec("https://example.com/a", "301"),
            rec("https://example.com/b", "200"),
        ])

        self.assertEqual(outcome.added, 1)
        self.assertEqual(outcome.duplicates, 1)
        self.assertEqual(
            collection.urls(), ("https://example.com/a", "https://example.com/b")
        )
        self.assertEqual(collection.records[0].status_code, "200")

    def test_duplicate_counts_are_reported(self):
        collection = ResultCollection()
        outcome = collection.append([
            rec("https://example.com/a"),
            rec("https://example.com/a"),
            rec("https://example.com/a"),
        ])

        self.assertEqual(outcome.added, 1)
        self.assertEqual(outcome.batch_duplicates, 2)
        self.assertEqual(outcome.total, 1)

    def test_blank_urls_are_not_silently_dropped(self):
        collection = ResultCollection([rec(""), rec("https://example.com/a")])
        self.assertEqual(collection.total_count, 2)


class FilterAndAppendTests(unittest.TestCase):
    def setUp(self):
        self.collection = ResultCollection([
            rec("https://example.com/a", "200"),
            rec("https://example.com/b", "301"),
            rec("https://example.com/c", "200"),
        ])

    def test_append_keeps_active_filter(self):
        self.assertEqual(self.collection.apply_filter(FilterSpec(status="200")), 2)
        self.collection.append([
            rec("https://example.com/d", "404"),
            rec("https://example.com/e", "200"),
        ])

        self.assertEqual(self.collection.total_count, 5)
        self.assertEqual(
            [record.url for record in self.collection.view],
            ["https://example.com/a", "https://example.com/c", "https://example.com/e"],
        )

    def test_append_keeps_active_sort(self):
        self.collection.set_sort("length", reverse=True)
        self.collection.append([rec("https://example.com/z", "200", "999")])

        lengths = [int(record.length) for record in self.collection.view]
        self.assertEqual(lengths, sorted(lengths, reverse=True))

    def test_filter_does_not_mutate_records(self):
        before = self.collection.urls()
        self.collection.apply_filter(FilterSpec(status="301"))
        self.assertEqual(self.collection.urls(), before)
        self.assertEqual(len(self.collection.view), 1)

    def test_sort_does_not_mutate_records(self):
        before = [record.url for record in self.collection.records]
        self.collection.set_sort("length")
        self.assertEqual([record.url for record in self.collection.records], before)

    def test_clear_filter_restores_full_view(self):
        self.collection.apply_filter(FilterSpec(status="200"))
        self.collection.clear_filter()
        self.assertEqual(self.collection.view_count, 3)

    def test_page_clamps_after_view_shrinks(self):
        self.assertEqual(self.collection.page_count(1), 3)
        self.collection.apply_filter(FilterSpec(status="200"))
        self.assertEqual(self.collection.page_count(1), 2)
        self.assertEqual(self.collection.page(5, 1), [])

    def test_pure_functions_return_new_lists(self):
        records = list(self.collection.records)
        filtered = apply_filter(records, FilterSpec(status="200"))
        sorted_records = sort_records(filtered, SortSpec("length", True))
        self.assertIsNot(filtered, records)
        self.assertIsNot(sorted_records, filtered)
        self.assertEqual(len(records), 3)


class ResultsTableWrapperTests(unittest.TestCase):
    def test_set_results_dedupes_first_record(self):
        table = support.make_table()
        table.set_results([
            rec("https://example.com/a", "200"),
            rec("https://example.com/a", "301"),
            rec("https://example.com/b"),
        ])

        self.assertEqual(len(table.filtered_results), 2)
        self.assertEqual(table.filtered_results[0].status_code, "200")

    def test_append_keeps_filter_and_updates_view(self):
        table = support.make_table([
            rec("https://example.com/a", "200"),
            rec("https://example.com/b", "301"),
        ])
        table.filter_status.set("200")
        table._apply_filters()
        self.assertEqual(len(table.filtered_results), 1)

        table.append_results([
            rec("https://example.com/c", "404"),
            rec("https://example.com/d", "200"),
        ])

        self.assertEqual(
            [record.url for record in table.filtered_results],
            ["https://example.com/a", "https://example.com/d"],
        )
        self.assertEqual(len(table.all_results), 4)

    def test_clear_filters_restores_full_view(self):
        table = support.make_table([
            rec("https://example.com/a", "200"),
            rec("https://example.com/b", "301"),
        ])
        table.filter_status.set("200")
        table._apply_filters()

        table._clear_filters()

        self.assertEqual(len(table.filtered_results), 2)
        self.assertEqual(table.filter_status.get(), "")

    def test_sort_applies_to_all_filtered_rows_not_page(self):
        records = [
            rec(f"https://example.com/{i}", "200", str(1000 - i)) for i in range(70)
        ]
        table = support.make_table(records, page_size=20)
        table.current_page = 3

        table._sort_by_column("length")

        self.assertEqual(table.current_page, 0)
        self.assertEqual(len(table.filtered_results), 70)
        lengths = [int(record.length) for record in table.filtered_results]
        self.assertEqual(lengths, sorted(lengths))

    def test_domain_filter_matches_core_semantics(self):
        table = support.make_table([
            rec("https://www.example.com/a"),
            rec("https://cdn.example.com/b"),
            rec("https://other.com/c"),
        ])
        table.filter_domain.set("example.com,!cdn.example.com")
        table._apply_filters()

        self.assertEqual(
            [record.url for record in table.filtered_results],
            ["https://www.example.com/a"],
        )

    def test_domain_filter_strips_single_count_suffix(self):
        table = support.make_table([
            rec("https://www.example.com/a"),
            rec("https://cdn.example.com/b"),
        ])
        table.filter_domain.set("www.example.com (1)")
        table._apply_filters()

        self.assertEqual(
            [record.url for record in table.filtered_results],
            ["https://www.example.com/a"],
        )


if __name__ == "__main__":
    unittest.main()
