import unittest

from archrecon import ArchiveRecord, FilterSpec, apply_filter, sort_records


def record(url, *, status="200", length="100", mime="text/html",
           timestamp="2024-01-01", source="wayback"):
    return ArchiveRecord(
        url=url,
        status_code=status,
        length=length,
        file_type=mime,
        timestamp=timestamp,
        source=source,
    )


RECORDS = [
    record("https://www.example.com/index.html", status="200", mime="text/html"),
    record("https://api.example.com/conf/app.json", status="403", mime="application/json"),
    record("https://example.com/assets/site.css", status="404", mime="text/css"),
    record("https://other.test/backup.sql", status="200", mime="application/octet-stream"),
]


def urls(records):
    return [item.url for item in records]


class StatusFilterTests(unittest.TestCase):
    def test_multiple_include_codes(self):
        filtered = apply_filter(RECORDS, FilterSpec(status="200,403"))

        self.assertEqual(len(filtered), 3)

    def test_exclude_codes(self):
        filtered = apply_filter(RECORDS, FilterSpec(status="!200,!404"))

        self.assertEqual(urls(filtered), ["https://api.example.com/conf/app.json"])

    def test_unknown_code_yields_empty_result(self):
        self.assertEqual(apply_filter(RECORDS, FilterSpec(status="999")), [])


class SubstringFilterTests(unittest.TestCase):
    def test_file_type_match_ignores_case(self):
        filtered = apply_filter(RECORDS, FilterSpec(file_type="APPLICATION"))

        self.assertEqual(len(filtered), 2)

    def test_multiple_include_terms_are_combined_with_and(self):
        filtered = apply_filter(RECORDS, FilterSpec(file_type="html,web"))

        self.assertEqual(filtered, [])

    def test_url_keyword_exclusion(self):
        filtered = apply_filter(RECORDS, FilterSpec(url_keyword="example.com,!api."))

        self.assertEqual(urls(filtered), [
            "https://www.example.com/index.html",
            "https://example.com/assets/site.css",
        ])


class DomainFilterTests(unittest.TestCase):
    def test_root_domain_also_matches_subdomains(self):
        filtered = apply_filter(RECORDS, FilterSpec(domain="example.com"))

        self.assertEqual(len(filtered), 3)
        self.assertNotIn("https://other.test/backup.sql", urls(filtered))

    def test_explicit_wildcard_is_equivalent(self):
        self.assertEqual(
            urls(apply_filter(RECORDS, FilterSpec(domain="*.example.com"))),
            urls(apply_filter(RECORDS, FilterSpec(domain="example.com"))),
        )

    def test_exclude_wins_over_include(self):
        filtered = apply_filter(RECORDS, FilterSpec(domain="example.com,!api.example.com"))

        self.assertEqual(urls(filtered), [
            "https://www.example.com/index.html",
            "https://example.com/assets/site.css",
        ])

    def test_count_suffix_from_dropdown_is_ignored(self):
        filtered = apply_filter(RECORDS, FilterSpec(domain="example.com (3)"))

        self.assertEqual(len(filtered), 3)


class InterestingPatternTests(unittest.TestCase):
    def test_interesting_only_keeps_matching_paths(self):
        filtered = apply_filter(RECORDS, FilterSpec(interesting_only=True))

        self.assertEqual(urls(filtered), ["https://other.test/backup.sql"])


class FilterSafetyTests(unittest.TestCase):
    def test_inactive_filter_returns_copy(self):
        filtered = apply_filter(RECORDS, FilterSpec())
        filtered.clear()

        self.assertEqual(len(RECORDS), 4)
        self.assertFalse(FilterSpec().is_active())
        self.assertTrue(FilterSpec(status=" ").is_active() is False)

    def test_filter_does_not_drop_records_without_hostname(self):
        records = [record(""), record("https://example.com/a")]
        filtered = apply_filter(records, FilterSpec(domain="example.com"))

        self.assertIn("", urls(filtered))

    def test_sort_returns_new_list(self):
        sorted_records = sort_records(RECORDS, None)
        sorted_records.clear()

        self.assertEqual(len(RECORDS), 4)


if __name__ == "__main__":
    unittest.main()
