import unittest

from archrecon import EXPORT_COLUMNS, ArchiveRecord


class ArchiveRecordTests(unittest.TestCase):
    def test_from_mapping_accepts_normalized_and_raw_field_names(self):
        normalized = ArchiveRecord.from_mapping({
            "url": "https://example.com/a",
            "status_code": "200",
            "length": "123",
            "file_type": "text/html",
            "timestamp": "2024-01-02",
            "source": "wayback",
        })
        raw_cdx = ArchiveRecord.from_mapping({
            "original": "https://example.com/b",
            "statuscode": "404",
            "length": None,
            "mimetype": "text/html; charset=utf-8",
            "timestamp": "20240102123456",
        })

        self.assertEqual(normalized.url, "https://example.com/a")
        self.assertEqual(normalized.file_type, "text/html")
        self.assertEqual(raw_cdx.url, "https://example.com/b")
        self.assertEqual(raw_cdx.status_code, "404")
        self.assertEqual(raw_cdx.length, "")
        self.assertEqual(raw_cdx.timestamp, "20240102123456")

    def test_from_mapping_coerces_non_string_values(self):
        record = ArchiveRecord.from_mapping({
            "url": "https://example.com/a",
            "status_code": 200,
            "length": 1024,
        })

        self.assertEqual(record.status_code, "200")
        self.assertEqual(record.length, "1024")

    def test_to_export_row_keeps_five_field_contract(self):
        record = ArchiveRecord(
            url="https://example.com/a",
            status_code="200",
            length="10",
            file_type="text/html",
            timestamp="2024-01-02",
            source="wayback",
            raw_timestamp="20240102111111",
        )

        row = record.to_export_row()

        self.assertEqual(len(EXPORT_COLUMNS), 5)
        self.assertEqual(tuple(row.keys()), EXPORT_COLUMNS)
        self.assertEqual(
            row,
            {
                "timestamp": "2024-01-02",
                "status_code": "200",
                "length": "10",
                "file_type": "text/html",
                "url": "https://example.com/a",
            },
        )
        # 界面行号与内部字段都不进入导出
        self.assertEqual(len(row), 5)
        self.assertNotIn("#", row)
        self.assertNotIn("source", row)
        self.assertNotIn("raw_timestamp", row)

    def test_full_mapping_keeps_source_and_raw_timestamp(self):
        record = ArchiveRecord.from_mapping({
            "url": "https://example.com/a",
            "source": "commoncrawl",
            "raw_timestamp": "20240102123456",
        })

        self.assertEqual(record.to_mapping()["source"], "commoncrawl")
        self.assertEqual(record.to_mapping()["raw_timestamp"], "20240102123456")

    def test_unknown_column_reads_as_empty_string(self):
        record = ArchiveRecord(url="https://example.com/a")

        self.assertEqual(record.value_of("#"), "")
        self.assertEqual(record.value_of("url"), "https://example.com/a")


if __name__ == "__main__":
    unittest.main()
