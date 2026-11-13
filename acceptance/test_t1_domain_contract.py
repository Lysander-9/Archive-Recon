"""T1 acceptance: target validation and source query-scope contract.

Criteria (adopted by the control agent):
- plain/wildcard/scheme/root-slash forms normalize deterministically;
- empty value, path, query, fragment, port, userinfo and internal whitespace
  are rejected, and rejection must not start a task or issue a request;
- both sources query the same intended scope for a root domain and for a
  wildcard input.

All source calls are intercepted locally; nothing here touches the network.
"""

import unittest
from unittest import mock
from urllib.parse import parse_qs, urlparse

import support

import main
from api_client import ArchiveAPIClient


VALID_CASES = [
    ("example.com", "example.com"),
    ("EXAMPLE.com", "example.com"),
    ("*.example.com", "*.example.com"),
    ("https://Example.com/", "example.com"),
    ("http://example.com", "example.com"),
    ("https://*.example.com/", "*.example.com"),
    (" example.com ", "example.com"),
]

INVALID_CASES = [
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
    # T1 explicitly requires rejecting userinfo and internal whitespace.
    ("user:pass@example.com", "用户信息"),
    ("https://user:pass@example.com/", "用户信息"),
    ("exa mple.com", "空白"),
    ("example .com", "空白"),
]


class DomainNormalizationTests(unittest.TestCase):
    def test_valid_forms_normalize(self):
        for raw, expected in VALID_CASES:
            with self.subTest(raw=raw):
                domain, error = main.ArchiveSearchApp._normalize_domain(raw)
                self.assertIsNone(error)
                self.assertEqual(domain, expected)

    def test_invalid_forms_are_rejected_with_reason(self):
        for raw, fragment in INVALID_CASES:
            with self.subTest(raw=raw):
                domain, error = main.ArchiveSearchApp._normalize_domain(raw)
                self.assertEqual(domain, "", f"accepted unexpectedly: {raw!r}")
                self.assertTrue(error, f"missing error message for {raw!r}")
                self.assertIn(fragment, error)


class NoRequestOnInvalidInputTests(unittest.TestCase):
    """T1: rejected input must not start a task or touch the source client."""

    def _fake_app(self, value):
        app = main.ArchiveSearchApp.__new__(main.ArchiveSearchApp)
        app.entry_domain = support.FakeEntry(value)
        app.lbl_status = support.FakeSink()
        app.client = mock.Mock()
        app._active_query_id = 0
        app.tabview = support.FakeSink()
        app.wayback_table = support.FakeTable()
        app.cc_table = support.FakeTable()
        app.lbl_cc_indexes = support.FakeSink()
        app.cc_index_ids = []
        app.cc_current_page = 0
        app.cc_failed_indexes = []
        app.cc_succeeded_indexes = []
        app.cc_truncated_indexes = []
        app.cc_time_selector = mock.Mock()
        app.cc_time_selector.get_query_params.return_value = {"months": 3}
        started = []
        app._query_starting = lambda: started.append(True)
        return app, started

    def _assert_rejected_without_side_effects(self, method_name, value):
        app, started = self._fake_app(value)
        with mock.patch.object(main.threading, "Thread") as thread_cls:
            getattr(main.ArchiveSearchApp, method_name)(app)
            thread_cls.assert_not_called()
        self.assertEqual(started, [], "query state was entered for invalid input")
        self.assertEqual(app.client.method_calls, [])
        self.assertTrue(app.lbl_status.text, "no user-facing error was shown")

    def test_wayback_invalid_inputs_do_not_start(self):
        for raw, _ in INVALID_CASES:
            with self.subTest(raw=raw):
                self._assert_rejected_without_side_effects("_start_wayback_query", raw)

    def test_common_crawl_invalid_inputs_do_not_start(self):
        for raw, _ in INVALID_CASES:
            with self.subTest(raw=raw):
                self._assert_rejected_without_side_effects("_start_cc_query", raw)


class SourceQueryScopeTests(unittest.TestCase):
    """T1: both sources must express the same intended scope."""

    @staticmethod
    def _wayback_response():
        return support.FakeResponse(
            json_data=[
                ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
                ["com,example)/", "20240102030405", "https://example.com/", "text/html", "200", "D", "1"],
            ]
        )

    @staticmethod
    def _cc_response():
        return support.FakeResponse(
            text='{"url": "https://example.com/", "status": "200", "mime": "text/html", "timestamp": "20240102030405", "length": "1"}'
        )

    def test_wayback_plain_and_wildcard_inputs_build_identical_queries(self):
        client = ArchiveAPIClient()
        transport = support.attach_transport(client, self._wayback_response())

        client.query_wayback("example.com", page=0, page_size=50, match_type="domain")
        client.query_wayback("*.example.com", page=0, page_size=50, match_type="domain")

        first = parse_qs(urlparse(transport.urls[0]).query, keep_blank_values=True)
        second = parse_qs(urlparse(transport.urls[1]).query, keep_blank_values=True)
        self.assertEqual(first, second)
        self.assertEqual(first["url"], ["example.com"])
        self.assertEqual(first["matchType"], ["domain"])
        self.assertEqual(first["collapse"], ["urlkey"])

    def test_common_crawl_plain_and_wildcard_inputs_build_identical_queries(self):
        client = ArchiveAPIClient()
        transport = support.attach_transport(client, self._cc_response())

        client.query_commoncrawl("CC-MAIN-TEST", "example.com", page=0, page_size=5, total_pages=1)
        client.query_commoncrawl("CC-MAIN-TEST", "*.example.com", page=0, page_size=5, total_pages=1)

        first = parse_qs(urlparse(transport.urls[0]).query, keep_blank_values=True)
        second = parse_qs(urlparse(transport.urls[1]).query, keep_blank_values=True)
        self.assertEqual(first, second)
        self.assertEqual(first["url"], ["*.example.com"])
        self.assertEqual(first["pageSize"], ["5"])

    def test_common_crawl_page_count_requests_server_metadata(self):
        client = ArchiveAPIClient()
        transport = support.attach_transport(
            client, support.FakeResponse(json_data=support.load_json("cc_page_count.json"))
        )

        pages = client.get_commoncrawl_page_count(
            "CC-MAIN-TEST", "example.com", page_size=5
        )

        query = parse_qs(urlparse(transport.urls[0]).query, keep_blank_values=True)
        self.assertEqual(pages, 3)
        self.assertEqual(query["showNumPages"], ["true"])
        self.assertEqual(query["pageSize"], ["5"])
        self.assertEqual(query["url"], ["*.example.com"])


class ResultDomainFilterTests(unittest.TestCase):
    """Existing P1 filter semantics that must survive the refactor."""

    def test_root_domain_matches_itself_and_subdomains_only(self):
        match = main.ResultsTable._match_domain_pattern
        self.assertTrue(match("example.com", "example.com"))
        self.assertTrue(match("www.example.com", "example.com"))
        self.assertTrue(match("a.b.example.com", "example.com"))
        self.assertFalse(match("badexample.com", "example.com"))
        self.assertFalse(match("example.com.evil.com", "example.com"))

    def test_explicit_wildcard_behaves_like_root_domain(self):
        match = main.ResultsTable._match_domain_pattern
        self.assertTrue(match("example.com", "*.example.com"))
        self.assertTrue(match("cdn.example.com", "*.example.com"))
        self.assertTrue(match("example.com", "https://example.com/"))

    def test_exclude_wins_and_empty_include_passes_everything(self):
        match_patterns = main.ResultsTable._match_domain_patterns
        urls = [
            "https://www.example.com/a",
            "https://cdn.example.com/b",
            "https://other.com/c",
        ]
        self.assertEqual(
            [u for u in urls if match_patterns(u, [], [])],
            urls,
        )
        self.assertEqual(
            [u for u in urls if match_patterns(u, ["example.com"], [])],
            urls[:2],
        )
        self.assertEqual(
            [u for u in urls if match_patterns(u, ["example.com"], ["cdn.example.com"])],
            urls[:1],
        )

    def test_domain_filter_keeps_unmatched_hosts_out_when_include_is_set(self):
        self.assertFalse(
            main.ResultsTable._match_domain_patterns("https://other.com/a", ["example.com"], [])
        )


if __name__ == "__main__":
    unittest.main()
