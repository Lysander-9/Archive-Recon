"""T6 acceptance (automatable part): import/startup contract.

The actual window launch is exercised by ``startup_smoke.py`` because it needs
a desktop session; this module only checks that the application entry points
import cleanly and that the declared runtime dependencies are present in
``requirements.txt``.
"""

import unittest
from pathlib import Path

import support  # noqa: F401  (puts the repository root on sys.path)

import main


class StartupContractTests(unittest.TestCase):
    def test_application_module_imports_and_exposes_entrypoint(self):
        self.assertTrue(hasattr(main, "ArchiveSearchApp"))
        self.assertTrue(callable(main.main))

    def test_results_table_declares_the_six_display_columns(self):
        columns = [item[0] for item in main.ResultsTable.COLUMNS]
        self.assertEqual(
            columns, ["#", "timestamp", "status_code", "length", "file_type", "url"]
        )

    def test_requirements_declare_gui_and_http_dependencies(self):
        requirements = (Path(support.ROOT) / "requirements.txt").read_text(
            encoding="utf-8"
        )
        self.assertIn("customtkinter", requirements)
        self.assertIn("requests", requirements)


if __name__ == "__main__":
    unittest.main()
