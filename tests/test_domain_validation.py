import unittest

from main import ArchiveSearchApp


class DomainValidationTests(unittest.TestCase):
    def test_accepts_plain_and_wildcard_domains(self):
        self.assertEqual(ArchiveSearchApp._normalize_domain("example.com"), ("example.com", None))
        self.assertEqual(ArchiveSearchApp._normalize_domain("*.example.com"), ("*.example.com", None))

    def test_strips_scheme_and_root_slash(self):
        self.assertEqual(ArchiveSearchApp._normalize_domain("https://Example.com/"), ("example.com", None))

    def test_rejects_path(self):
        domain, error = ArchiveSearchApp._normalize_domain("example.com/path")
        self.assertEqual(domain, "")
        self.assertIn("不接受路径", error)

    def test_rejects_port(self):
        domain, error = ArchiveSearchApp._normalize_domain("example.com:8080")
        self.assertEqual(domain, "")
        self.assertIn("端口号", error)

    def test_rejects_empty_input(self):
        domain, error = ArchiveSearchApp._normalize_domain("  ")
        self.assertEqual(domain, "")
        self.assertIn("请输入目标域名", error)

    def test_rejects_malformed_port(self):
        domain, error = ArchiveSearchApp._normalize_domain("example.com:bad")
        self.assertEqual(domain, "")
        self.assertIn("端口格式", error)


if __name__ == "__main__":
    unittest.main()
