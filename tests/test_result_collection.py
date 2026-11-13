import unittest

from archrecon import ArchiveRecord, FilterSpec, ResultCollection


def record(url, *, status="200", length="100", mime="text/html",
           timestamp="2024-01-01", source="wayback"):
    return ArchiveRecord(
        url=url,
        status_code=status,
        length=length,
        file_type=mime,
        timestamp=timestamp,
        source=source,
    )


class DedupeTests(unittest.TestCase):
    def test_duplicate_in_same_batch_keeps_first_record(self):
        collection = ResultCollection()

        outcome = collection.append([
            record("https://example.com/a", timestamp="2024-01-01"),
            record("https://example.com/a", timestamp="2025-09-09"),
            record("https://example.com/b", timestamp="2024-02-02"),
        ])

        self.assertEqual(outcome.added, 2)
        self.assertEqual(outcome.batch_duplicates, 1)
        self.assertEqual(outcome.duplicates, 1)
        self.assertEqual(
            [item.timestamp for item in collection.records],
            ["2024-01-01", "2024-02-02"],
        )

    def test_duplicate_across_batches_keeps_first_record(self):
        collection = ResultCollection([record("https://example.com/a", timestamp="2024-01-01")])

        outcome = collection.append([
            record("https://example.com/a", timestamp="2025-09-09"),
            record("https://example.com/b"),
        ])

        self.assertEqual(outcome.added, 1)
        self.assertEqual(outcome.known_duplicates, 1)
        self.assertEqual(outcome.batch_duplicates, 0)
        self.assertEqual([item.url for item in collection.records],
                         ["https://example.com/a", "https://example.com/b"])
        self.assertEqual(collection.records[0].timestamp, "2024-01-01")

    def test_protocol_path_and_query_variants_stay_distinct(self):
        collection = ResultCollection([
            record("http://example.com/a"),
            record("https://example.com/a"),
            record("https://example.com/a?x=1"),
            record("https://example.com/a/"),
        ])

        self.assertEqual(collection.total_count, 4)

    def test_reset_also_dedupes(self):
        collection = ResultCollection([
            record("https://example.com/a"),
            record("https://example.com/a"),
            record("https://example.com/b"),
        ])

        self.assertEqual(collection.total_count, 2)

    def test_records_without_url_are_not_silently_dropped(self):
        collection = ResultCollection([record(""), record("")])

        self.assertEqual(collection.total_count, 2)


class FilteredViewTests(unittest.TestCase):
    def setUp(self):
        self.collection = ResultCollection([
            record("https://example.com/1", status="200"),
            record("https://example.com/2", status="404"),
        ])

    def test_append_after_filter_keeps_filter_and_original_set(self):
        self.collection.apply_filter(FilterSpec(status="200"))

        self.collection.append([
            record("https://example.com/3", status="200"),
            record("https://example.com/4", status="404"),
        ])

        self.assertEqual([item.url for item in self.collection.view],
                         ["https://example.com/1", "https://example.com/3"])
        self.assertEqual(
            [item.url for item in self.collection.records],
            [
                "https://example.com/1",
                "https://example.com/2",
                "https://example.com/3",
                "https://example.com/4",
            ],
        )

    def test_clear_filter_restores_full_set(self):
        self.collection.apply_filter(FilterSpec(status="200"))

        self.assertEqual(self.collection.clear_filter(), 2)
        self.assertEqual(2, self.collection.view_count)

    def test_append_after_sort_keeps_sorted_view(self):
        collection = ResultCollection([
            record("https://example.com/a", timestamp="2024-03-01"),
            record("https://example.com/b", timestamp="2024-01-01"),
        ])
        collection.set_sort("timestamp")

        collection.append([record("https://example.com/c", timestamp="2024-02-01")])

        self.assertEqual([item.url for item in collection.view],
                         ["https://example.com/b", "https://example.com/c", "https://example.com/a"])
        self.assertEqual([item.url for item in collection.records],
                         ["https://example.com/a", "https://example.com/b", "https://example.com/c"])

    def test_filter_and_sort_combined_survive_append(self):
        self.collection.apply_filter(FilterSpec(status="200"))
        self.collection.set_sort("url", reverse=True)

        self.collection.append([
            record("https://example.com/5", status="200"),
            record("https://example.com/9", status="404"),
        ])

        self.assertEqual([item.url for item in self.collection.view],
                         ["https://example.com/5", "https://example.com/1"])


class SortingTests(unittest.TestCase):
    def setUp(self):
        self.collection = ResultCollection([
            record("https://example.com/a", status="404", length="10", timestamp="2024-03-01"),
            record("https://example.com/b", status="200", length="900", timestamp="2024-01-01"),
            record("https://example.com/c", status="301", length="5", timestamp="2024-02-01"),
        ])
        self.original_order = [item.url for item in self.collection.records]

    def test_numeric_columns_sort_as_numbers(self):
        self.collection.set_sort("length")

        self.assertEqual([item.length for item in self.collection.view], ["5", "10", "900"])

    def test_sorting_never_mutates_original_order(self):
        self.collection.set_sort("timestamp")
        self.collection.set_sort("timestamp", reverse=True)
        self.collection.clear_sort()

        self.assertEqual([item.url for item in self.collection.records], self.original_order)

    def test_reverse_sort_keeps_filtered_set(self):
        self.collection.set_sort("timestamp", reverse=True)

        self.assertEqual([item.url for item in self.collection.view],
                         ["https://example.com/a", "https://example.com/c", "https://example.com/b"])


class PaginationAndSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.collection = ResultCollection(
            [record(f"https://example.com/{index}", status="200" if index < 70 else "404")
             for index in range(120)]
        )

    def test_page_slices_view_and_reports_page_count(self):
        self.collection.set_sort("url")

        self.assertEqual(len(self.collection.page(0, 50)), 50)
        self.assertEqual(len(self.collection.page(2, 50)), 20)
        self.assertEqual(self.collection.page(3, 50), [])
        self.assertEqual(self.collection.page_count(50), 3)
        self.assertEqual(self.collection.page_count(200), 1)

    def test_snapshot_matches_view_order_and_size(self):
        self.collection.apply_filter(FilterSpec(status="200"))
        self.collection.set_sort("timestamp", reverse=True)

        snapshot = self.collection.snapshot()

        self.assertEqual(len(snapshot), 70)
        self.assertEqual([row["url"] for row in snapshot],
                         [item.url for item in self.collection.view])
        self.assertEqual(set(snapshot[0].keys()),
                         {"timestamp", "status_code", "length", "file_type", "url"})

    def test_page_count_after_empty_filter_is_one(self):
        self.collection.apply_filter(FilterSpec(status="999"))

        self.assertEqual(self.collection.view_count, 0)
        self.assertEqual(self.collection.page_count(50), 1)
        self.assertEqual(self.collection.snapshot(), [])


if __name__ == "__main__":
    unittest.main()
