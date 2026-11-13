"""PR #1 acceptance: T2 task lifecycle and event ownership (offline).

The core target is independence of a restarted query from a stopped one, plus
terminal-state behaviour.  Callback tests use the real PR #1 methods with a
Tk-free app object and a live ``JobCoordinator``.
"""

import unittest
from unittest import mock

import pr1_support as support

import main
from archrecon import (
    InvalidJobTransition,
    JobCoordinator,
    JobStatus,
)


class CoordinatorTests(unittest.TestCase):
    def test_start_supersedes_unfinished_previous_job(self):
        jobs = JobCoordinator()
        first = jobs.start("wayback")
        second = jobs.start("commoncrawl")

        self.assertEqual(first.status, JobStatus.STOPPED)
        self.assertTrue(first.is_terminal)
        self.assertFalse(jobs.accepts(first.job_id))
        self.assertFalse(jobs.accepts_data(first.job_id))
        self.assertTrue(jobs.accepts(second.job_id))
        self.assertTrue(jobs.accepts_data(second.job_id))

    def test_terminal_job_accepts_no_more_data(self):
        jobs = JobCoordinator()
        job = jobs.start("wayback")
        job.mark_running()
        job.finish(JobStatus.COMPLETED, "done")

        self.assertFalse(jobs.accepts_data(job.job_id))
        self.assertEqual(job.finish(JobStatus.PARTIAL, "late"), JobStatus.COMPLETED)
        with self.assertRaises(InvalidJobTransition):
            job.transition(JobStatus.RUNNING)

    def test_stop_event_is_set_on_terminal_and_stop_request(self):
        jobs = JobCoordinator()
        job = jobs.start("wayback")
        job.mark_running()
        job.request_stop()
        self.assertTrue(job.stop_event.is_set())
        self.assertEqual(job.status, JobStatus.STOPPING)
        job.finish(JobStatus.STOPPED, "user")
        self.assertEqual(job.status, JobStatus.STOPPED)

    def test_completed_with_partial_completeness_becomes_partial(self):
        jobs = JobCoordinator()
        job = jobs.start("wayback")
        job.mark_running()
        job.completeness = "partial"
        job.finish(JobStatus.COMPLETED)

        self.assertEqual(job.status, JobStatus.PARTIAL)


class StaleEventTests(unittest.TestCase):
    def test_old_wayback_batch_is_dropped_after_restart(self):
        app, _ = support.make_app()
        old_job = app.jobs.active_job
        new_job = app.jobs.start("wayback")
        app._current_job = new_job
        app._stop_event = new_job.stop_event

        main.ArchiveSearchApp._on_wayback_batch(
            app, old_job.job_id, [support.record("https://example.com/old")], 0
        )
        self.assertEqual(app.wayback_table.collection.total_count, 0)

        main.ArchiveSearchApp._on_wayback_batch(
            app, new_job.job_id, [support.record("https://example.com/new")], 0
        )
        self.assertEqual(
            app.wayback_table.collection.urls(), ("https://example.com/new",)
        )

    def test_old_common_crawl_callbacks_are_dropped(self):
        app, _ = support.make_app()
        old_job = app.jobs.active_job
        new_job = app.jobs.start("commoncrawl")
        app.cc_index_ids = ["CC-MAIN-A"]

        main.ArchiveSearchApp._on_cc_indexes_ready(app, old_job.job_id, ["CC-MAIN-OLD"])
        main.ArchiveSearchApp._on_cc_page_done(
            app, old_job.job_id, "CC-MAIN-OLD", [support.record("https://example.com/old")], 1, 1
        )
        main.ArchiveSearchApp._on_cc_page_error(
            app, old_job.job_id, "CC-MAIN-OLD", "boom", None
        )

        self.assertEqual(app.load_calls, [])
        self.assertEqual(app.cc_table.collection.total_count, 0)
        self.assertEqual(app.cc_failed_indexes, [])
        self.assertEqual(app.done_calls, [])
        self.assertEqual(old_job.status, JobStatus.STOPPED)
        self.assertTrue(app.jobs.accepts(new_job.job_id))


class StopTests(unittest.TestCase):
    def test_stop_prevents_further_wayback_pages_and_keeps_records(self):
        app, job = support.make_app()
        job.mark_running()
        calls = []

        class Client:
            def query_wayback(self, **kwargs):
                calls.append(kwargs["page"])
                job.stop_event.set()
                return {
                    "results": [support.record("https://example.com/kept")],
                    "has_more": True,
                }

        app.client = Client()
        main.ArchiveSearchApp._do_wayback_query(
            app, job.job_id, "example.com", job.stop_event
        )

        self.assertEqual(calls, [0])
        self.assertEqual(job.status, JobStatus.STOPPED)
        self.assertEqual(
            app.wayback_table.collection.urls(), ("https://example.com/kept",)
        )
        self.assertIn("已停止", app.lbl_status.text)
        self.assertTrue(app.done_calls)

    def test_stop_message_does_not_claim_instant_cancellation(self):
        app, job = support.make_app()
        app.btn_stop = support.FakeSink()
        app._stop_event = job.stop_event

        main.ArchiveSearchApp._stop_query(app)

        self.assertEqual(job.status, JobStatus.STOPPING)
        self.assertIn("等待当前请求返回", app.lbl_status.text)


class CommonCrawlCompletenessTests(unittest.TestCase):
    def _last_index_app(self, index_ids):
        app, job = support.make_app()
        job.mark_running()
        app.cc_index_ids = list(index_ids)
        app.cc_current_page = len(index_ids) - 1
        return app, job

    def test_one_failed_index_keeps_other_results(self):
        app, job = support.make_app()
        job.mark_running()
        app.cc_index_ids = ["CC-MAIN-A", "CC-MAIN-B", "CC-MAIN-C"]
        app.cc_current_page = 0

        main.ArchiveSearchApp._on_cc_page_done(
            app, job.job_id, "CC-MAIN-A", [support.record("https://example.com/a")], 1, 1
        )
        main.ArchiveSearchApp._on_cc_page_done(
            app, job.job_id, "CC-MAIN-B", [support.record("https://example.com/b")], 1, 1
        )
        main.ArchiveSearchApp._on_cc_page_error(
            app, job.job_id, "CC-MAIN-C", "synthetic", None
        )

        self.assertEqual(
            app.cc_table.collection.urls(),
            ("https://example.com/a", "https://example.com/b"),
        )
        self.assertEqual(job.status, JobStatus.PARTIAL)
        self.assertIn("部分完成", app.lbl_status.text)
        self.assertIn("1 个索引失败", app.lbl_status.text)
        self.assertIn("CC-MAIN-C", app.lbl_cc_indexes.text)

    def test_all_failed_indexes_marks_job_failed(self):
        app, job = self._last_index_app(["CC-MAIN-A"])

        main.ArchiveSearchApp._on_cc_page_error(
            app, job.job_id, "CC-MAIN-A", "synthetic", None
        )

        self.assertEqual(job.status, JobStatus.FAILED)
        self.assertIn("查询失败", app.lbl_status.text)

    def test_page_cap_marks_job_partial_and_lists_index(self):
        app, job = self._last_index_app(["CC-MAIN-A"])

        main.ArchiveSearchApp._on_cc_page_done(
            app, job.job_id, "CC-MAIN-A", [support.record("https://example.com/a")],
            total_pages=7, pages_fetched=5,
        )

        self.assertEqual(job.status, JobStatus.PARTIAL)
        self.assertEqual(app.cc_truncated_indexes, ["CC-MAIN-A"])
        self.assertIn("5 页上限", app.lbl_status.text)
        self.assertIn("CC-MAIN-A", app.lbl_cc_indexes.text)

    def test_partial_rows_from_failed_page_are_kept(self):
        app, job = self._last_index_app(["CC-MAIN-A"])

        main.ArchiveSearchApp._on_cc_page_error(
            app, job.job_id, "CC-MAIN-A", "synthetic",
            [support.record("https://example.com/partial")],
        )

        self.assertEqual(
            app.cc_table.collection.urls(), ("https://example.com/partial",)
        )
        self.assertEqual(job.status, JobStatus.PARTIAL)

    def test_target_edit_during_cc_task_must_not_change_later_requests(self):
        """T2: query parameters are frozen when the task starts."""
        app, job = support.make_app(initial_domain="original.example.com")
        job.mark_running()
        app.cc_index_ids = ["CC-MAIN-A", "CC-MAIN-B"]
        app.cc_current_page = 0
        app.entry_domain = support.FakeEntry("new.example.com")
        del app._load_cc_page  # exercise the real loader, not the recording stub
        captured = {}

        def fake_thread(target=None, args=(), daemon=None):
            captured["args"] = args
            return mock.Mock()

        with mock.patch.object(main.threading, "Thread", side_effect=fake_thread):
            main.ArchiveSearchApp._on_cc_indexes_ready(
                app, job.job_id, ["CC-MAIN-A", "CC-MAIN-B"]
            )

        self.assertEqual(
            captured["args"][2],
            "original.example.com",
            "the running task re-read the edited target input",
        )


if __name__ == "__main__":
    unittest.main()
