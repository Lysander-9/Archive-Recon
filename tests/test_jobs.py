import unittest

from archrecon import (
    InvalidJobTransition,
    JobCoordinator,
    JobStatus,
    QueryJob,
)


class JobTransitionTests(unittest.TestCase):
    def test_normal_lifecycle(self):
        job = QueryJob(job_id=1, source="wayback")

        job.mark_running()
        job.finish(JobStatus.COMPLETED)

        self.assertEqual(job.status, JobStatus.COMPLETED)
        self.assertTrue(job.is_terminal)
        self.assertIsNotNone(job.finished_at)

    def test_terminal_job_rejects_further_transitions(self):
        job = QueryJob(job_id=1, source="wayback")
        job.finish(JobStatus.STOPPED)

        with self.assertRaises(InvalidJobTransition):
            job.transition(JobStatus.RUNNING)

    def test_non_terminal_finish_is_rejected(self):
        job = QueryJob(job_id=1, source="wayback")

        with self.assertRaises(InvalidJobTransition):
            job.finish(JobStatus.RUNNING)

    def test_request_stop_sets_event_and_stopping_state(self):
        job = QueryJob(job_id=1, source="wayback")
        job.mark_running()

        job.request_stop()

        self.assertEqual(job.status, JobStatus.STOPPING)
        self.assertTrue(job.stop_event.is_set())
        self.assertTrue(job.accepts_data)

    def test_finish_sets_stop_event(self):
        job = QueryJob(job_id=1, source="wayback")

        job.finish(JobStatus.COMPLETED)

        self.assertTrue(job.stop_event.is_set())

    def test_partial_completeness_downgrades_completed(self):
        job = QueryJob(job_id=1, source="commoncrawl")
        job.completeness = "partial"

        job.finish(JobStatus.COMPLETED)

        self.assertEqual(job.status, JobStatus.PARTIAL)

    def test_note_batch_counts_events(self):
        job = QueryJob(job_id=1, source="wayback")

        job.note_batch(50, 50)
        job.note_batch(50, 97)

        self.assertEqual(job.received_count, 100)
        self.assertEqual(job.unique_count, 97)
        self.assertEqual(job.status, JobStatus.RUNNING)


class JobOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.coordinator = JobCoordinator()

    def test_first_job_accepts_its_events(self):
        job = self.coordinator.start("wayback")

        self.assertEqual(self.coordinator.active_job_id, job.job_id)
        self.assertTrue(self.coordinator.accepts(job.job_id))
        self.assertTrue(self.coordinator.accepts_data(job.job_id))

    def test_events_from_unknown_job_are_rejected(self):
        self.coordinator.start("wayback")

        self.assertFalse(self.coordinator.accepts(0))
        self.assertFalse(self.coordinator.accepts(999))
        self.assertFalse(self.coordinator.accepts(None))

    def test_stale_events_are_dropped_after_stop_and_restart(self):
        first = self.coordinator.start("wayback")
        first.request_stop()
        first.finish(JobStatus.STOPPED)

        second = self.coordinator.start("wayback")

        self.assertNotEqual(first.job_id, second.job_id)
        self.assertFalse(self.coordinator.accepts(first.job_id))
        self.assertFalse(self.coordinator.accepts_data(first.job_id))
        self.assertTrue(self.coordinator.accepts_data(second.job_id))

    def test_restart_without_finishing_marks_previous_job_stopped(self):
        first = self.coordinator.start("commoncrawl")
        second = self.coordinator.start("wayback")

        self.assertEqual(first.status, JobStatus.STOPPED)
        self.assertTrue(first.is_terminal)
        self.assertTrue(first.stop_event.is_set())
        self.assertTrue(self.coordinator.accepts_data(second.job_id))
        self.assertFalse(self.coordinator.accepts_data(first.job_id))

    def test_terminal_job_no_longer_accepts_data(self):
        job = self.coordinator.start("wayback")
        self.coordinator.finish_active(JobStatus.PARTIAL, "部分失败")

        self.assertTrue(self.coordinator.accepts(job.job_id))
        self.assertFalse(self.coordinator.accepts_data(job.job_id))

    def test_finish_active_is_idempotent(self):
        job = self.coordinator.start("wayback")
        self.coordinator.finish_active(JobStatus.COMPLETED)

        self.coordinator.finish_active(JobStatus.FAILED, "不应覆盖")

        self.assertEqual(job.status, JobStatus.COMPLETED)
        self.assertEqual(job.reason, "")


if __name__ == "__main__":
    unittest.main()
