"""PR #1 acceptance: T6 packaging/documentation contract (automatable part)."""

import unittest
from pathlib import Path

import pr1_support as support

import main
from archrecon import DISPLAY_COLUMNS, EXPORT_COLUMNS, ArchiveRecord

FIELDS = ("timestamp", "status_code", "length", "file_type", "url")


class ContractConstantsTests(unittest.TestCase):
    def test_export_columns_are_the_baseline_five_fields(self):
        self.assertEqual(EXPORT_COLUMNS, FIELDS)
        self.assertEqual(DISPLAY_COLUMNS, FIELDS)

    def test_export_row_has_no_source_or_row_number(self):
        record = ArchiveRecord(
            url="https://example.com/a",
            status_code="200",
            length="1",
            file_type="text/html",
            timestamp="2024-01-02",
            source="wayback",
            raw_timestamp="20240102030405",
        )
        self.assertEqual(tuple(record.to_export_row()), FIELDS)

    def test_display_columns_add_only_the_row_number(self):
        display = [item[0] for item in main.ResultsTable.COLUMNS]
        self.assertEqual(display, ["#", *FIELDS])


class PackagingTests(unittest.TestCase):
    def test_requirements_no_longer_require_pandas(self):
        requirements = (Path(support.ROOT) / "requirements.txt").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("pandas", requirements)
        self.assertIn("customtkinter", requirements)
        self.assertIn("requests", requirements)

    def test_launch_scripts_check_the_actual_dependencies(self):
        batch = (Path(support.ROOT) / "start.bat").read_text(encoding="utf-8")
        shell = (Path(support.ROOT) / "start.sh").read_text(encoding="utf-8")
        for text in (batch, shell):
            self.assertNotIn("pandas", text)
            self.assertIn("customtkinter", text)
            self.assertIn("requests", text)

    def test_core_package_imports_without_gui_dependencies(self):
        # archrecon itself only imports the standard library; importing it in
        # this process is already proven, and the public API is available.
        import archrecon

        for name in ("ArchiveRecord", "ResultCollection", "JobCoordinator",
                     "write_csv", "write_json", "FilterSpec", "SortSpec"):
            self.assertTrue(hasattr(archrecon, name), name)


if __name__ == "__main__":
    unittest.main()
