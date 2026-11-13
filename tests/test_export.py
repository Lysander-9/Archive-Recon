import csv
import json
import os
import tempfile
import unittest

from archrecon import (
    AppError,
    ArchiveRecord,
    ErrorCode,
    FilterSpec,
    ResultCollection,
    write_csv,
    write_json,
)


def build_collection(total=120, matching=70):
    records = []
    for index in range(total):
        status = "200" if index < matching else "404"
        records.append(ArchiveRecord(
            url=f"https://example.com/item/{index}",
            status_code=status,
            length=str(100 + index),
            file_type="text/html",
            timestamp="2024-01-02",
            source="wayback",
        ))
    return ResultCollection(records)


class ExportAlignmentTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.collection = build_collection()
        self.collection.apply_filter(FilterSpec(status="200"))
        self.collection.set_sort("timestamp")

    def path(self, name):
        return os.path.join(self.temp_dir.name, name)

    def test_export_from_middle_page_contains_full_filtered_snapshot(self):
        page_two = self.collection.page(1, 20)
        self.assertEqual(len(page_two), 20)

        csv_path = self.path("results.csv")
        json_path = self.path("results.json")
        csv_count = write_csv(self.collection.snapshot(), csv_path)
        json_count = write_json(self.collection.snapshot(), json_path)

        self.assertEqual(csv_count, 70)
        self.assertEqual(json_count, 70)
        with open(json_path, encoding="utf-8") as handle:
            exported = json.load(handle)
        self.assertEqual(len(exported), 70)
        self.assertEqual([row["url"] for row in exported],
                         [item.url for item in self.collection.view])

    def test_csv_keeps_header_order_bom_and_record_count(self):
        csv_path = self.path("results.csv")
        write_csv(self.collection.snapshot(), csv_path)

        with open(csv_path, "rb") as handle:
            raw = handle.read()
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))

        with open(csv_path, encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.reader(handle))

        self.assertEqual(rows[0], ["timestamp", "status_code", "length", "file_type", "url"])
        self.assertEqual(len(rows), 71)
        self.assertNotIn("#", rows[0])
        self.assertNotIn("source", rows[0])

    def test_json_matches_filtered_view_and_column_order(self):
        json_path = self.path("results.json")
        write_json(self.collection.snapshot(), json_path)

        with open(json_path, encoding="utf-8") as handle:
            exported = json.load(handle)

        self.assertEqual(list(exported[0].keys()),
                         ["timestamp", "status_code", "length", "file_type", "url"])
        self.assertEqual(exported, self.collection.snapshot())

    def test_csv_roundtrip_keeps_unicode_commas_and_newlines(self):
        tricky = ArchiveRecord(
            url="https://example.com/路径/a,b?x=1",
            status_code="200",
            length="1",
            file_type="text/plain",
            timestamp="2024-01-02",
            source="wayback",
        )
        collection = ResultCollection([tricky])
        collection.apply_filter(FilterSpec(url_keyword="路径"))
        csv_path = self.path("tricky.csv")

        write_csv(collection.snapshot(), csv_path)

        with open(csv_path, encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.reader(handle))
        self.assertEqual(rows[1][4], "https://example.com/路径/a,b?x=1")

        json_path = self.path("tricky.json")
        write_json(collection.snapshot(), json_path)
        with open(json_path, encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)[0]["url"], "https://example.com/路径/a,b?x=1")

    def test_empty_result_exports_header_only_and_empty_array(self):
        self.collection.apply_filter(FilterSpec(status="999"))
        csv_path = self.path("empty.csv")
        json_path = self.path("empty.json")

        self.assertEqual(write_csv(self.collection.snapshot(), csv_path), 0)
        self.assertEqual(write_json(self.collection.snapshot(), json_path), 0)

        with open(csv_path, encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.reader(handle))
        self.assertEqual(rows, [["timestamp", "status_code", "length", "file_type", "url"]])

        with open(json_path, encoding="utf-8") as handle:
            self.assertEqual(json.load(handle), [])

    def test_partial_results_remain_exportable(self):
        collection = ResultCollection([ArchiveRecord(url="https://example.com/a", status_code="200")])
        collection.append([ArchiveRecord(url="https://example.com/b", status_code="200")])

        csv_path = self.path("partial.csv")
        self.assertEqual(write_csv(collection.snapshot(), csv_path), 2)

    def test_failed_write_raises_app_error_and_leaves_no_temp_file(self):
        target_directory = self.path("as-directory")
        os.makedirs(target_directory)

        with self.assertRaises(AppError) as context:
            write_csv(self.collection.snapshot(), target_directory)

        self.assertEqual(context.exception.code, ErrorCode.EXPORT)
        self.assertEqual(
            [name for name in os.listdir(self.temp_dir.name) if name.startswith(".archrecon-")],
            [],
        )


if __name__ == "__main__":
    unittest.main()
