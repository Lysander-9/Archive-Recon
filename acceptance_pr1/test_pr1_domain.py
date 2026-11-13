"""PR #1 acceptance: T1 target validation and source query scope (offline)."""

import unittest
from types import SimpleNamespace
from unittest import mock
from urllib.parse import parse_qs, urlparse
import threading

import pr1_support as support

import main
from api_client import ArchiveAPIClient
from archrecon.matching import match_domain_pattern, match_domain_patterns


VALID = [
    ("example.com", "example.com"),
    ("EXAMPLE.com", "example.com"),
    ("*.example.com", "*.example.com"),
    ("https://Example.com/", "example.com"),
    ("http://example.com", "example.com"),
    ("https://*.example.com/", "*.example.com"),
    (" example.com ", "example.com"),
]

INVALID = [
    ("", "请输入目标域名"),
    ("   ", "请输入目标域名"),
    ("example.com/path", "路径"),
    ("example.com?x=1", "路径"),
    ("example.com#frag", "路径"),
    ("example.com:8080", "端口"),
    ("example.com:bad", "端口格式"),
    ("ftp://example.com", "域名格式无效"),
    ("http://", "域名格式无效"),
    ("example.com.", "域名格式无效"),
    ("-bad.example.com", "域名格式无效"),
    ("bad-.example.com", "域名格式无效"),
    ("user:pass@example.com", "用户信息"),
    ("https://user:pass@example.com/", "用户信息"),
    ("exa mple.com", "空白"),
    ("example .com", "空白"),
]


class TargetValidationTests(unittest.TestCase):
    def test_valid_forms_normalize(self):
        for raw, expected in VALID:
            with self.subTest(raw=raw):
                host, error = main.ArchiveSearchApp._normalize_domain(raw)
                self.assertIsNone(error)
                self.assertEqual(host, expected)

    def test_invalid_forms_are_rejected_with_reason(self):
        for raw, fragment in INVALID:
            with self.subTest(raw=raw):
                host, error = main.ArchiveSearchApp._normalize_domain(raw)
                self.assertEqual(host, "", f"accepted unexpectedly: {raw!r}")
                self.assertTrue(error)
                self.assertIn(fragment, error)

    def _assert_wayback_rejects_without_start(self, value):
        app, _ = support.make_app()
        app.entry_domain = support.FakeEntry(value)
        started = []
        job = SimpleNamespace(job_id=999, stop_event=threading.Event())
        app._query_starting = lambda source: (started.append(source), job)[1]
        with mock.patch.object(main.threading, "Thread") as thread_cls:
            main.ArchiveSearchApp._start_wayback_query(app)
            thread_cls.assert_not_called()
        self.assertEqual(started, [])

    def _assert_cc_rejects_without_start(self, value):
        app, _ = support.make_app()
        app.entry_domain = support.FakeEntry(value)
        started = []
        job = SimpleNamespace(job_id=999, stop_event=threading.Event())
        app._query_starting = lambda source: (started.append(source), job)[1]
        with mock.patch.object(main.threading, "Thread") as thread_cls:
            main.ArchiveSearchApp._start_cc_query(app)
            thread_cls.assert_not_called()
        self.assertEqual(started, [])

    def test_wayback_rejected_inputs_do_not_start(self):
        for raw, _ in INVALID:
            with self.subTest(raw=raw):
                self._assert_wayback_rejects_without_start(raw)

    def test_common_crawl_rejected_inputs_do_not_start(self):
        for raw, _ in INVALID:
            with self.subTest(raw=raw):
                self._assert_cc_rejects_without_start(raw)


class QueryScopeTests(unittest.TestCase):
    def test_wayback_plain_and_wildcard_build_same_query(self):
        client = ArchiveAPIClient()
        transport = support.attach_transport(
            client,
            support.FakeResponse(
                json_data=[
                    ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
                    ["k", "20240102030405", "https://example.com/", "text/html", "200", "D", "1"],
                ]
            ),
        )
        client.query_wayback("example.com", page=0, page_size=50, match_type="domain")
        client.query_wayback("*.example.com", page=0, page_size=50, match_type="domain")

        first = parse_qs(urlparse(transport.urls[0]).query, keep_blank_values=True)
        second = parse_qs(urlparse(transport.urls[1]).query, keep_blank_values=True)
        self.assertEqual(first, second)
        self.assertEqual(first["url"], ["example.com"])
        self.assertEqual(first["matchType"], ["domain"])
        self.assertEqual(first["collapse"], ["urlkey"])

    def test_common_crawl_plain_and_wildcard_build_same_query(self):
        client = ArchiveAPIClient()
        transport = support.attach_transport(
            client,
            support.FakeResponse(
                text='{"url": "https://example.com/", "status": "200", "mime": "text/html", "length": "1"}'
            ),
        )
        client.query_commoncrawl("CC-MAIN-TEST", "example.com", page=0, page_size=5, total_pages=1)
        client.query_commoncrawl("CC-MAIN-TEST", "*.example.com", page=0, page_size=5, total_pages=1)

        first = parse_qs(urlparse(transport.urls[0]).query, keep_blank_values=True)
        second = parse_qs(urlparse(transport.urls[1]).query, keep_blank_values=True)
        self.assertEqual(first, second)
        self.assertEqual(first["url"], ["*.example.com"])
        self.assertEqual(first["pageSize"], ["5"])


class ResultDomainFilterTests(unittest.TestCase):
    def test_root_domain_matches_self_and_subdomains_only(self):
        self.assertTrue(match_domain_pattern("example.com", "example.com"))
        self.assertTrue(match_domain_pattern("www.example.com", "example.com"))
        self.assertTrue(match_domain_pattern("a.b.example.com", "example.com"))
        self.assertFalse(match_domain_pattern("badexample.com", "example.com"))
        self.assertFalse(match_domain_pattern("example.com.evil.com", "example.com"))

    def test_wildcard_and_count_suffix(self):
        self.assertTrue(match_domain_pattern("cdn.example.com", "*.example.com"))
        self.assertTrue(match_domain_pattern("example.com", "https://example.com/"))

    def test_exclude_wins(self):
        urls = [
            "https://www.example.com/a",
            "https://cdn.example.com/b",
            "https://other.com/c",
        ]
        kept = [
            url for url in urls
            if match_domain_patterns(url, ["example.com"], ["cdn.example.com"])
        ]
        self.assertEqual(kept, ["https://www.example.com/a"])

    def test_results_table_wrapper_uses_core_matching(self):
        self.assertTrue(main.ResultsTable._match_domain_pattern("www.example.com", "example.com"))
        self.assertTrue(
            main.ResultsTable._match_domain_patterns(
                "https://www.example.com/a", ["example.com"], []
            )
        )


if __name__ == "__main__":
    unittest.main()
