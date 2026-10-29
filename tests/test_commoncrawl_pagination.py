import json
import unittest
from types import SimpleNamespace

from api_client import ArchiveAPIClient


class CommonCrawlPaginationTests(unittest.TestCase):
    def setUp(self):
        self.client = ArchiveAPIClient()

    def test_record_count_does_not_determine_more_pages(self):
        rows = [
            json.dumps({"url": f"https://example.com/{i}", "status": "200", "mime": "text/html"})
            for i in range(51)
        ]
        response = SimpleNamespace(text="\n".join(rows))
        self.client._request_with_retry = lambda _url: response

        result = self.client.query_commoncrawl(
            "CC-MAIN-TEST", "example.com", page=0, page_size=5, total_pages=1
        )

        self.assertEqual(len(result["results"]), 51)
        self.assertFalse(result["has_more"])

    def test_more_pages_comes_from_index_page_count(self):
        response = SimpleNamespace(text='{"url":"https://example.com/","status":"200","mime":"text/html"}')
        self.client._request_with_retry = lambda _url: response

        result = self.client.query_commoncrawl(
            "CC-MAIN-TEST", "example.com", page=1, page_size=5, total_pages=3
        )

        self.assertTrue(result["has_more"])

    def test_page_count_is_fetched_when_not_supplied(self):
        response = SimpleNamespace(text='{"url":"https://example.com/","status":"200","mime":"text/html"}')
        self.client._request_with_retry = lambda _url: response
        self.client.get_commoncrawl_page_count = lambda *_args, **_kwargs: 2

        result = self.client.query_commoncrawl("CC-MAIN-TEST", "example.com", page=0)

        self.assertTrue(result["has_more"])

    def test_filters_keep_their_existing_positional_argument(self):
        response = SimpleNamespace(text='{"url":"https://example.com/","status":"200","mime":"text/html"}')
        requested = []
        self.client._request_with_retry = lambda url: (requested.append(url), response)[1]
        self.client.get_commoncrawl_page_count = lambda *_args, **_kwargs: 1

        self.client.query_commoncrawl("CC-MAIN-TEST", "example.com", 0, 5, ["status:200"])

        self.assertIn("filter=status:200", requested[0])

    def test_page_count_query_requests_server_page_metadata(self):
        response = SimpleNamespace(json=lambda: {"pages": 7})
        requested = []
        self.client._request_with_retry = lambda url: (requested.append(url), response)[1]

        pages = self.client.get_commoncrawl_page_count("CC-MAIN-TEST", "example.com", page_size=5)

        self.assertEqual(pages, 7)
        self.assertIn("showNumPages=true", requested[0])
        self.assertIn("pageSize=5", requested[0])

    def test_multi_index_query_never_exceeds_per_index_record_limit(self):
        rows = [
            {"url": f"https://example.com/{i}", "status_code": "200"}
            for i in range(501)
        ]
        self.client.get_commoncrawl_page_count = lambda *_args, **_kwargs: 1
        self.client.query_commoncrawl = lambda **_kwargs: {"results": rows, "has_more": False}

        results = self.client.query_commoncrawl_multi(
            ["CC-MAIN-TEST"], "example.com", max_per_index=500,
        )

        self.assertEqual(len(results), 500)


if __name__ == "__main__":
    unittest.main()
