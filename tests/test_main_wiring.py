"""main.py 接线的回归测试（需要 Tk 环境，无法创建窗口时跳过）。

覆盖：任务事件归属、停止重启、追加后的筛选排序、导出快照一致性。
这些用例不访问外部服务。
"""

import os
import tempfile
import unittest
from unittest import mock

try:
    import main
    from archrecon import write_csv, write_json
except Exception as error:  # pragma: no cover - 依赖缺失时跳过
    main = None
    write_csv = write_json = None
    _IMPORT_ERROR = error
else:
    _IMPORT_ERROR = None


def record(url, *, status="200", timestamp="2024-01-01", length="10"):
    return {
        "url": url,
        "status_code": status,
        "length": length,
        "file_type": "text/html",
        "timestamp": timestamp,
        "source": "wayback",
    }


@unittest.skipIf(main is None, f"GUI 依赖不可用：{_IMPORT_ERROR}")
class MainWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.app = main.ArchiveSearchApp()
            cls.app.withdraw()
            cls.app.update_idletasks()
        except Exception as error:  # pragma: no cover - 无显示环境
            raise unittest.SkipTest(f"无法创建 Tk 窗口：{error}")

    @classmethod
    def tearDownClass(cls):
        cls.app.destroy()

    def setUp(self):
        app = self.app
        for table in (app.wayback_table, app.cc_table):
            table._clear_filters()
            table.set_results([])
            table.collection.clear_sort()
            table.sort_column = None
            table.sort_reverse = False
            table.page_size = 50
            table.current_page = 0
        app.cc_index_ids = []
        app.cc_current_page = 0
        app.cc_querying = False
        app.cc_failed_indexes = []
        app.cc_succeeded_indexes = []
        app.cc_truncated_indexes = []
        app.update_idletasks()

    def start_job(self):
        return self.app._query_starting("wayback")

    def test_stale_events_after_stop_and_restart_are_dropped(self):
        first = self.start_job()
        self.app._on_wayback_batch(first.job_id, [record("https://example.com/a")], 0)
        self.app._stop_query()
        self.app._on_wayback_stopped(first.job_id)
        self.assertTrue(first.stop_event.is_set())

        second = self.start_job()
        self.app.wayback_table.set_results([])  # 与 _start_wayback_query 的清理顺序一致
        self.app._on_wayback_batch(first.job_id, [record("https://example.com/old")], 1)
        self.app._on_wayback_done(first.job_id)
        self.app._on_wayback_batch(second.job_id, [record("https://example.com/b")], 0)

        self.assertEqual(
            [item.url for item in self.app.wayback_table.collection.records],
            ["https://example.com/b"],
        )

    def test_restart_uses_a_new_cancel_event(self):
        first = self.start_job()
        second = self.start_job()

        self.assertIsNot(first.stop_event, second.stop_event)
        self.assertTrue(first.stop_event.is_set())
        self.assertFalse(second.stop_event.is_set())
        self.assertEqual(first.status, main.JobStatus.STOPPED)

    def test_append_after_filter_keeps_filter_and_original_order(self):
        job = self.start_job()
        self.app._on_wayback_batch(job.job_id, [
            record("https://example.com/1", status="200"),
            record("https://example.com/2", status="404"),
        ], 0)
        table = self.app.wayback_table
        table.filter_status.set("200")
        table._apply_filters()
        base_order = [item.url for item in table.collection.records]

        table.append_results([
            record("https://example.com/3", status="200"),
            record("https://example.com/3", status="200"),
            record("https://example.com/4", status="404"),
        ])

        self.assertEqual(
            [item.url for item in table.collection.view],
            ["https://example.com/1", "https://example.com/3"],
        )
        self.assertEqual([item.url for item in table.collection.records][:2], base_order)
        self.assertEqual(len(table.collection.records), 4)

    def test_sort_does_not_change_original_records(self):
        job = self.start_job()
        self.app._on_wayback_batch(job.job_id, [
            record("https://example.com/a", timestamp="2024-03-01"),
            record("https://example.com/b", timestamp="2024-01-01"),
        ], 0)
        table = self.app.wayback_table

        table._sort_by_column("timestamp")

        self.assertEqual(
            [item.url for item in table.collection.view],
            ["https://example.com/b", "https://example.com/a"],
        )
        self.assertEqual(
            [item.url for item in table.collection.records],
            ["https://example.com/a", "https://example.com/b"],
        )

    def test_export_snapshot_matches_filtered_view(self):
        job = self.start_job()
        records = [record(f"https://example.com/{i}", status="200" if i < 70 else "404")
                   for i in range(120)]
        self.app._on_wayback_batch(job.job_id, records, 0)
        table = self.app.wayback_table
        table.page_size = 20
        table.filter_status.set("200")
        table._apply_filters()
        table.current_page = 2

        snapshot = table._export_snapshot()

        self.assertEqual(len(snapshot), 70)
        self.assertEqual([row["url"] for row in snapshot],
                         [item.url for item in table.collection.view])
        with tempfile.TemporaryDirectory() as temp_dir:
            csv_path = os.path.join(temp_dir, "results.csv")
            json_path = os.path.join(temp_dir, "results.json")
            self.assertEqual(write_csv(snapshot, csv_path), 70)
            self.assertEqual(write_json(snapshot, json_path), 70)

    def test_stopped_job_keeps_partial_results_exportable(self):
        job = self.start_job()
        self.app._on_wayback_batch(job.job_id, [
            record("https://example.com/a"),
            record("https://example.com/b"),
        ], 0)
        self.app._stop_query()
        self.app._on_wayback_stopped(job.job_id)

        snapshot = self.app.wayback_table._export_snapshot()

        self.assertEqual(len(snapshot), 2)
        self.assertEqual(job.status, main.JobStatus.STOPPED)

    def test_clear_filters_restores_full_view(self):
        job = self.start_job()
        self.app._on_wayback_batch(job.job_id, [
            record("https://example.com/1", status="200"),
            record("https://example.com/2", status="404"),
        ], 0)
        table = self.app.wayback_table
        table.filter_status.set("200")
        table._apply_filters()

        table._clear_filters()

        self.assertEqual(table.collection.view_count, 2)

    def test_job_events_after_completion_are_ignored(self):
        job = self.start_job()
        self.app._on_wayback_done(job.job_id)
        self.assertEqual(job.status, main.JobStatus.COMPLETED)

        self.app._on_wayback_batch(job.job_id, [record("https://example.com/late")], 1)

        self.assertEqual(self.app.wayback_table.collection.total_count, 0)

    def test_cc_page_event_from_previous_job_is_dropped(self):
        first = self.app._query_starting("commoncrawl")
        self.app.cc_index_ids = ["CC-MAIN-2024-01"]
        second = self.app._query_starting("commoncrawl")
        self.app.cc_index_ids = ["CC-MAIN-2024-02"]
        self.app.cc_current_page = 0

        self.app._on_cc_page_done(
            first.job_id, "CC-MAIN-2024-01", [record("https://example.com/old")], 1, 1
        )
        self.assertEqual(self.app.cc_table.collection.total_count, 0)

        self.app._on_cc_page_done(
            second.job_id, "CC-MAIN-2024-02", [record("https://example.com/new")], 1, 1
        )
        self.assertEqual(
            [item.url for item in self.app.cc_table.collection.records],
            ["https://example.com/new"],
        )
        self.assertEqual(second.status, main.JobStatus.COMPLETED)

    def test_cc_partial_index_failure_keeps_results_exportable(self):
        job = self.app._query_starting("commoncrawl")
        self.app.cc_index_ids = ["CC-MAIN-2024-01", "CC-MAIN-2024-02"]
        self.app.cc_current_page = 0

        with mock.patch.object(self.app, "_load_cc_page"):
            self.app._on_cc_page_done(
                job.job_id, "CC-MAIN-2024-01",
                [record("https://example.com/a"), record("https://example.com/b")], 1, 1,
            )
            self.app._on_cc_page_error(job.job_id, "CC-MAIN-2024-02", "boom")

        self.assertEqual(job.status, main.JobStatus.PARTIAL)
        self.assertEqual(len(self.app.cc_table._export_snapshot()), 2)
        self.assertEqual(len(self.app.cc_failed_indexes), 1)


if __name__ == "__main__":
    unittest.main()
