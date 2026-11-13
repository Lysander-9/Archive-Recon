"""T5 acceptance: export and copy contract, verified by real files on disk.

Baseline contract under test (observed, not assumed):
- CSV/JSON contain exactly five data fields in this order:
  timestamp, status_code, length, file_type, url;
- CSV is UTF-8 with BOM; JSON is a UTF-8 array of objects;
- export uses the full filtered snapshot, not the visible page;
- empty filtered set -> CSV header only / JSON [];
- cancellation writes nothing; a write failure is not reported as success.
"""

import csv
import json
import os
import tempfile
import unittest
from unittest import mock

import support

import main

FIELD_ORDER = ["timestamp", "status_code", "length", "file_type", "url"]


class ExportTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def export(self, table, method, filename):
        path = os.path.join(self.tmp.name, filename)
        with mock.patch.object(
            main.filedialog, "asksaveasfilename", return_value=path
        ) as save_dialog, mock.patch.object(main.messagebox, "showinfo") as info, mock.patch.object(
            main.messagebox, "showerror"
        ) as error:
            getattr(table, method)()
        return path, save_dialog, info, error


class FieldContractTests(ExportTestBase):
    def test_csv_has_exactly_the_baseline_five_fields(self):
        record = support.record("https://example.com/a")
        table = support.make_table([record])

        path, _, info, error = self.export(table, "_export_csv", "out.csv")

        info.assert_called_once()
        error.assert_not_called()
        raw = open(path, "rb").read()
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"), "CSV must keep the UTF-8 BOM")
        with open(path, newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            self.assertEqual(reader.fieldnames, FIELD_ORDER)
            rows = list(reader)
        self.assertEqual(len(rows), 1)
        self.assertEqual(set(rows[0]), set(FIELD_ORDER))
        self.assertNotIn("#", rows[0])
        self.assertNotIn("source", rows[0])

    def test_json_has_exactly_the_baseline_five_fields_in_order(self):
        record = support.record("https://example.com/a")
        table = support.make_table([record])

        path, _, info, error = self.export(table, "_export_json", "out.json")

        info.assert_called_once()
        error.assert_not_called()
        data = json.load(open(path, encoding="utf-8"))
        self.assertIsInstance(data, list)
        self.assertEqual(len(data), 1)
        self.assertEqual(list(data[0]), FIELD_ORDER)
        self.assertNotIn("source", data[0])

    def test_internal_source_field_is_not_exported(self):
        record = support.record("https://example.com/a", source="commoncrawl")
        table = support.make_table([record])

        csv_path, _, _, _ = self.export(table, "_export_csv", "out.csv")
        json_path, _, _, _ = self.export(table, "_export_json", "out.json")
        table.source_name = "commoncrawl"

        with open(csv_path, encoding="utf-8-sig") as handle:
            header = next(csv.reader(handle))
        self.assertEqual(header, FIELD_ORDER)
        self.assertEqual(list(json.load(open(json_path, encoding="utf-8"))[0]), FIELD_ORDER)


class ExportScopeTests(ExportTestBase):
    def test_export_includes_all_filtered_records_not_just_visible_page(self):
        records = [
            support.record(f"https://example.com/{i}", str(200 if i < 70 else 404))
            for i in range(120)
        ]
        table = support.make_table(records, page_size=20)
        table.filtered_results = records[:70]
        table.current_page = 5  # last page of 70 records at 20 rows/page

        csv_path, _, _, _ = self.export(table, "_export_csv", "filtered.csv")
        json_path, _, _, _ = self.export(table, "_export_json", "filtered.json")

        with open(csv_path, newline="", encoding="utf-8-sig") as handle:
            csv_rows = list(csv.DictReader(handle))
        json_rows = json.load(open(json_path, encoding="utf-8"))
        self.assertEqual(len(csv_rows), 70)
        self.assertEqual(len(json_rows), 70)
        self.assertEqual({row["url"] for row in csv_rows}, {row["url"] for row in json_rows})

    def test_empty_filtered_set_exports_header_only_csv_and_empty_json(self):
        table = support.make_table()
        table.filtered_results = []

        csv_path, _, _, _ = self.export(table, "_export_csv", "empty.csv")
        json_path, _, _, _ = self.export(table, "_export_json", "empty.json")

        with open(csv_path, newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            self.assertEqual(reader.fieldnames, FIELD_ORDER)
            self.assertEqual(list(reader), [])
        self.assertEqual(json.load(open(json_path, encoding="utf-8")), [])


class RoundTripTests(ExportTestBase):
    def test_chinese_commas_and_newlines_survive_a_csv_round_trip(self):
        tricky = support.record(
            "https://example.com/路径,含逗号\n第二行",
            "403",
            "0",
            "text/plain",
            "2024-05-06",
        )
        table = support.make_table([tricky])

        path, _, _, _ = self.export(table, "_export_csv", "tricky.csv")

        with open(path, newline="", encoding="utf-8-sig") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(rows[0], {key: tricky[key] for key in FIELD_ORDER})

    def test_chinese_is_written_as_utf8_json_not_escaped(self):
        tricky = support.record("https://example.com/中文")
        table = support.make_table([tricky])

        path, _, _, _ = self.export(table, "_export_json", "tricky.json")

        raw = open(path, "rb").read()
        self.assertIn("中文".encode("utf-8"), raw)
        self.assertNotIn(b"\\u4e2d", raw)
        self.assertEqual(json.load(open(path, encoding="utf-8"))[0]["url"], tricky["url"])


class FailurePathTests(ExportTestBase):
    def test_cancelled_save_dialog_writes_nothing_and_reports_nothing(self):
        table = support.make_table([support.record("https://example.com/a")])

        with mock.patch.object(
            main.filedialog, "asksaveasfilename", return_value=""
        ), mock.patch.object(main.messagebox, "showinfo") as info, mock.patch.object(
            main.messagebox, "showerror"
        ) as error:
            table._export_csv()
            table._export_json()

        info.assert_not_called()
        error.assert_not_called()
        self.assertEqual(os.listdir(self.tmp.name), [])

    def test_write_failure_reports_error_not_success(self):
        table = support.make_table([support.record("https://example.com/a")])
        missing_dir = os.path.join(self.tmp.name, "missing", "out.csv")

        with mock.patch.object(
            main.filedialog, "asksaveasfilename", return_value=missing_dir
        ), mock.patch.object(main.messagebox, "showinfo") as info, mock.patch.object(
            main.messagebox, "showerror"
        ) as error:
            table._export_csv()

        info.assert_not_called()
        error.assert_called_once()
        self.assertFalse(os.path.exists(missing_dir))


if __name__ == "__main__":
    unittest.main()
