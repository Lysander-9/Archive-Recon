"""来源客户端解析与不完整原因的回归测试（离线夹具，不访问外部目标）。"""

import json
import unittest

import requests

from api_client import APIError, ArchiveAPIClient


class FakeResponse:
    def __init__(self, *, status_code=200, text="", json_data=None):
        self.status_code = status_code
        self.text = text
        self._json_data = json_data

    def json(self):
        return self._json_data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")


class Transport:
    def __init__(self, responses):
        self._responses = list(responses)
        self.urls = []

    def __call__(self, url):
        self.urls.append(url)
        item = self._responses[min(len(self.urls) - 1, len(self._responses) - 1)]
        if isinstance(item, Exception):
            raise item
        return item


CC_GOOD_LINE = '{"url": "https://example.com/a", "status": "200", "mime": "text/html", "length": "10"}'
CC_SECOND_LINE = '{"url": "https://example.com/b", "status": "301", "mime": "text/html", "length": "20"}'
CC_MALFORMED_LINE = "this line is not valid JSON and is expected to be skipped"
CC_ARRAY_LINE = '["not", "a", "record"]'


def attach(client, *responses):
    transport = Transport(responses)
    client._request_with_retry = transport
    return transport


class CommonCrawlParseSignalTests(unittest.TestCase):
    def test_malformed_line_is_counted_and_keeps_valid_records(self):
        client = ArchiveAPIClient()
        attach(client, FakeResponse(text="\n".join([
            CC_GOOD_LINE, CC_MALFORMED_LINE, CC_SECOND_LINE,
        ])))

        result = client.query_commoncrawl(
            "CC-MAIN-TEST", "example.com", page=0, page_size=5, total_pages=1
        )

        self.assertEqual(len(result["results"]), 2)
        self.assertEqual(result["parse_skipped"], 1)
        self.assertEqual(len(result["incomplete_reasons"]), 1)
        reason = result["incomplete_reasons"][0]
        self.assertEqual(reason["code"], "parse_line")
        self.assertEqual(reason["source"], "commoncrawl")
        self.assertEqual(reason["index_id"], "CC-MAIN-TEST")
        self.assertEqual(reason["page"], 0)
        self.assertEqual(reason["count"], 1)
        self.assertEqual(reason["context"]["line_numbers"], (2,))

    def test_non_object_json_line_is_counted(self):
        client = ArchiveAPIClient()
        attach(client, FakeResponse(text="\n".join([CC_GOOD_LINE, CC_ARRAY_LINE])))

        result = client.query_commoncrawl(
            "CC-MAIN-TEST", "example.com", page=0, page_size=5, total_pages=1
        )

        self.assertEqual(len(result["results"]), 1)
        self.assertEqual(result["parse_skipped"], 1)
        self.assertEqual(result["incomplete_reasons"][0]["count"], 1)

    def test_clean_response_has_zero_skipped_and_no_reasons(self):
        client = ArchiveAPIClient()
        attach(client, FakeResponse(text="\n".join([CC_GOOD_LINE, CC_SECOND_LINE])))

        result = client.query_commoncrawl(
            "CC-MAIN-TEST", "example.com", page=0, page_size=5, total_pages=1
        )

        self.assertEqual(result["parse_skipped"], 0)
        self.assertEqual(result["incomplete_reasons"], [])

    def test_blank_lines_are_not_counted_as_parse_errors(self):
        client = ArchiveAPIClient()
        attach(client, FakeResponse(text=f"\n\n{CC_GOOD_LINE}\n\n"))

        result = client.query_commoncrawl(
            "CC-MAIN-TEST", "example.com", page=0, page_size=5, total_pages=1
        )

        self.assertEqual(result["parse_skipped"], 0)

    def test_empty_body_returns_empty_result_with_signal_keys(self):
        client = ArchiveAPIClient()
        attach(client, FakeResponse(text=""))

        result = client.query_commoncrawl(
            "CC-MAIN-TEST", "example.com", page=0, page_size=5, total_pages=1
        )

        self.assertEqual(result["results"], [])
        self.assertEqual(result["parse_skipped"], 0)
        self.assertEqual(result["incomplete_reasons"], [])


class WaybackParseSignalTests(unittest.TestCase):
    HEADERS = ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"]

    def test_short_row_is_counted_and_valid_rows_kept(self):
        client = ArchiveAPIClient()
        payload = [
            self.HEADERS,
            ["k1", "20240102030405", "https://example.com/a", "text/html", "200", "D1", "1"],
            ["k2", "20240103040506"],
            ["k3", "20240104050607", "https://example.com/c", "text/html", "200", "D3", "3"],
        ]
        attach(client, FakeResponse(json_data=payload))

        result = client.query_wayback("example.com", page=0, page_size=50)

        self.assertEqual(len(result["results"]), 2)
        self.assertEqual(result["parse_skipped"], 1)
        self.assertEqual(result["incomplete_reasons"][0]["code"], "parse_line")
        self.assertEqual(result["incomplete_reasons"][0]["source"], "wayback")

    def test_non_array_payload_is_reported_instead_of_silently_empty(self):
        client = ArchiveAPIClient()
        attach(client, FakeResponse(json_data={"error": "unexpected"}))

        result = client.query_wayback("example.com", page=0, page_size=50)

        self.assertEqual(result["results"], [])
        self.assertEqual(result["parse_skipped"], 1)
        self.assertEqual(result["incomplete_reasons"][0]["code"], "parse_record")

    def test_empty_array_has_no_parse_signal(self):
        client = ArchiveAPIClient()
        attach(client, FakeResponse(json_data=[]))

        result = client.query_wayback("example.com", page=0, page_size=50)

        self.assertEqual(result["results"], [])
        self.assertEqual(result["parse_skipped"], 0)
        self.assertEqual(result["incomplete_reasons"], [])


class BoundedRetryAndErrorTests(unittest.TestCase):
    class TimeoutSession:
        def __init__(self):
            self.calls = 0

        def get(self, url, timeout=None):
            self.calls += 1
            raise requests.Timeout("synthetic")

    def test_retry_budget_is_bounded_to_configured_attempts(self):
        client = ArchiveAPIClient(max_retries=2)
        session = self.TimeoutSession()
        client.session = session

        from unittest import mock

        with mock.patch("api_client.time.sleep", return_value=None):
            with self.assertRaises(APIError) as context:
                client._request_with_retry("https://example.invalid/")

        self.assertEqual(session.calls, 2)
        self.assertTrue(context.exception.retryable)

    def test_api_error_carries_structured_reason(self):
        error = APIError("boom", source="wayback", retryable=True)

        reason = error.to_reason(page=3)

        self.assertEqual(reason["code"], "network")
        self.assertEqual(reason["source"], "wayback")
        self.assertEqual(reason["page"], 3)
        self.assertTrue(reason["retryable"])

    def test_common_crawl_page_count_error_has_source_and_index(self):
        client = ArchiveAPIClient()
        attach(client, FakeResponse(json_data=["not", "an", "object"]))

        with self.assertRaises(APIError) as context:
            client.get_commoncrawl_page_count("CC-MAIN-TEST", "example.com")

        self.assertEqual(context.exception.source, "commoncrawl")
        self.assertEqual(context.exception.index_id, "CC-MAIN-TEST")


class ReadLimitTests(unittest.TestCase):
    def test_wayback_paginated_stops_at_max_pages(self):
        client = ArchiveAPIClient()
        page = [
            ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
            ["k", "20240102030405", "https://example.com/a", "text/html", "200", "D", "1"],
        ]
        transport = attach(client, FakeResponse(json_data=page))

        results = client.query_wayback_paginated("example.com", page_size=1, max_pages=2)

        self.assertEqual(len(transport.urls), 2)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["url"], "https://example.com/a")

    def test_common_crawl_multi_respects_per_index_limit(self):
        client = ArchiveAPIClient()
        rows = [{"url": f"https://example.com/{i}", "status_code": "200"} for i in range(12)]
        client.get_commoncrawl_page_count = lambda *_args, **_kwargs: 1
        client.query_commoncrawl = lambda **_kwargs: {"results": rows, "has_more": False}

        results = client.query_commoncrawl_multi(
            ["CC-MAIN-TEST"], "example.com", max_per_index=5
        )

        self.assertEqual(len(results), 5)


if __name__ == "__main__":
    unittest.main()
