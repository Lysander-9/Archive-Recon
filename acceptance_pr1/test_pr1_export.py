"""PR #1 acceptance: export must match the baseline five-field sample.

The reference is the baseline file output measured in
``acceptance/BASELINE_REPORT.md`` (commit 8e6aaf9), not the developer's own
tests: header ``timestamp,status_code,length,file_type,url``, UTF-8 BOM CSV,
UTF-8 JSON array, no ``source`` and no row number.
"""

import csv
import json
import os
import tempfile
import unittest
from unittest import mock

import pr1_support as support

import main
from archrecon import ArchiveRecord, ResultCollection, write_csv, write_json

FIELDS = ["timestamp", "status_code", "length", "file_type", "url"]


def archive_records():
    return [
        ArchiveRecord(
            url="https://example.com/a,b\n第二行",
            status_code="200",
            length="512",
            file_type="text/html",
            timestamp="2024-01-02",
            source="wayback",
            raw_timestamp="20240102030405",
        ),
        ArchiveRecord(
            url="https://example.com/中文",
            status_code="404",
            length="0",
            file_type="application/json",
            timestamp="2024-05-06",
            source="commoncrawl",
            raw_timestamp="20240506070809",
        ),
    ]


class ExportWriterContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_csv_bytes_match_baseline_five_field_contract(self):
        path = os.path.join(self.tmp.name, "out.csv")
        count = write_csv([r.to_export_row() for r in archive_records()], path)

        self.assertEqual(count, 2)
        raw = open(path, "rb").read()
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"), "UTF-8 BOM missing")
        with open(path, newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            self.assertEqual(reader.fieldnames, FIELDS)
            rows = list(reader)
        self.assertEqual(len(rows), 2)
        self.assertEqual(list(rows[0]), FIELDS)
        self.assertNotIn("source", rows[0])
        self.assertNotIn("raw_timestamp", rows[0])
        self.assertNotIn("#", rows[0])
        self.assertEqual(rows[0]["url"], "https://example.com/a,b\n第二行")
        self.assertEqual(rows[0]["timestamp"], "2024-01-02")

    def test_json_matches_baseline_five_field_contract(self):
        path = os.path.join(self.tmp.name, "out.json")
        count = write_json([r.to_export_row() for r in archive_records()], path)

        self.assertEqual(count, 2)
        raw = open(path, "rb").read()
        self.assertIn("中文".encode("utf-8"), raw)
        self.assertNotIn(b"\\u4e2d", raw)
        data = json.loads(raw.decode("utf-8"))
        self.assertEqual([list(row) for row in data], [FIELDS, FIELDS])
        self.assertEqual(data[0]["url"], "https://example.com/a,b\n第二行")
        self.assertNotIn("source", data[0])

    def test_archive_record_keeps_source_and_raw_timestamp_internally_only(self):
        record = archive_records()[0]
        self.assertEqual(record.source, "wayback")
        self.assertEqual(record.raw_timestamp, "20240102030405")
        self.assertEqual(list(record.to_export_row()), FIELDS)


class GuiExportPathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def _table(self, records):
        table = support.make_table()
        table.collection = ResultCollection(records)
        return table

    def _export(self, table, method, name):
        path = os.path.join(self.tmp.name, name)
        with mock.patch.object(
            main.filedialog, "asksaveasfilename", return_value=path
        ), mock.patch.object(main.messagebox, "showinfo") as info, mock.patch.object(
            main.messagebox, "showerror"
        ) as error:
            getattr(table, method)()
        return path, info, error

    def test_results_table_export_uses_five_field_core_writer(self):
        table = self._table(archive_records())

        csv_path, info, error = self._export(table, "_export_csv", "gui.csv")
        json_path, info2, error2 = self._export(table, "_export_json", "gui.json")

        info.assert_called_once()
        info2.assert_called_once()
        error.assert_not_called()
        error2.assert_not_called()
        with open(csv_path, newline="", encoding="utf-8-sig") as handle:
            self.assertEqual(csv.DictReader(handle).fieldnames, FIELDS)
        data = json.load(open(json_path, encoding="utf-8"))
        self.assertEqual(list(data[0]), FIELDS)

    def test_export_snapshot_is_filtered_view_not_current_page(self):
        records = [
            support.record(f"https://example.com/{i}", str(200 if i < 70 else 404),
                           str(1000 - i))
            for i in range(120)
        ]
        table = self._table(records)
        table.page_size = 20
        table.current_page = 5
        from archrecon import FilterSpec

        table.collection.apply_filter(FilterSpec(status="200"))

        snapshot = table._export_snapshot()
        self.assertEqual(len(snapshot), 70)
        self.assertEqual({row["status_code"] for row in snapshot}, {"200"})

        path, _, _ = self._export(table, "_export_csv", "snapshot.csv")
        with open(path, newline="", encoding="utf-8-sig") as handle:
            self.assertEqual(len(list(csv.DictReader(handle))), 70)

    def test_empty_snapshot_writes_header_only_and_empty_json(self):
        table = self._table([])

        csv_path, _, _ = self._export(table, "_export_csv", "empty.csv")
        json_path, _, _ = self._export(table, "_export_json", "empty.json")

        with open(csv_path, newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            self.assertEqual(reader.fieldnames, FIELDS)
            self.assertEqual(list(reader), [])
        self.assertEqual(json.load(open(json_path, encoding="utf-8")), [])

    def test_cancelled_dialog_writes_nothing(self):
        table = self._table(archive_records())

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
        table = self._table(archive_records())
        bad_path = os.path.join(self.tmp.name, "missing", "out.csv")

        with mock.patch.object(
            main.filedialog, "asksaveasfilename", return_value=bad_path
        ), mock.patch.object(main.messagebox, "showinfo") as info, mock.patch.object(
            main.messagebox, "showerror"
        ) as error:
            table._export_csv()

        info.assert_not_called()
        error.assert_called_once()
        self.assertFalse(os.path.exists(bad_path))

    def test_atomic_write_leaves_no_temp_file(self):
        path = os.path.join(self.tmp.name, "atomic.csv")
        write_csv([r.to_export_row() for r in archive_records()], path)

        leftovers = [name for name in os.listdir(self.tmp.name) if name.startswith(".archrecon-")]
        self.assertEqual(leftovers, [])
        self.assertTrue(os.path.exists(path))


if __name__ == "__main__":
    unittest.main()
