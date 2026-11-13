"""核心层严格域名校验的回归测试（离线，不依赖 GUI/网络）。

对应独立验收报告 T1 的四类误接受输入：用户信息两种写法、域名内部空白两种写法；
同时锁定与基线一致的允许写法与拒绝矩阵，避免“修好一处、放宽另一处”。
"""

import unittest

from archrecon import AppError, DomainTarget, ErrorCode, normalize_domain, parse_domain

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
]

# 独立验收报告点名的四类输入
REJECTED_USERINFO = [
    "user:pass@example.com",
    "https://user:pass@example.com/",
]
REJECTED_WHITESPACE = [
    "exa mple.com",
    "example .com",
]


class AcceptedFormsTests(unittest.TestCase):
    def test_accepted_forms_normalize(self):
        for raw, expected in VALID:
            with self.subTest(raw=raw):
                host, error = normalize_domain(raw)
                self.assertIsNone(error)
                self.assertEqual(host, expected)

    def test_normalization_is_idempotent(self):
        host, error = normalize_domain("https://Example.com/")

        self.assertIsNone(error)
        self.assertEqual(normalize_domain(host), (host, None))


class RejectedFormsTests(unittest.TestCase):
    def test_userinfo_is_rejected(self):
        for raw in REJECTED_USERINFO:
            with self.subTest(raw=raw):
                host, error = normalize_domain(raw)
                self.assertEqual(host, "")
                self.assertIn("用户信息", error)

    def test_internal_whitespace_is_rejected(self):
        for raw in REJECTED_WHITESPACE:
            with self.subTest(raw=raw):
                host, error = normalize_domain(raw)
                self.assertEqual(host, "")
                self.assertIn("空白", error)

    def test_internal_whitespace_variants_are_rejected(self):
        for raw in ("exa\tmple.com", "exa\nmple.com", "exa\u00a0mple.com"):
            with self.subTest(raw=repr(raw)):
                host, error = normalize_domain(raw)
                self.assertEqual(host, "")
                self.assertIn("空白", error)

    def test_baseline_rejections_are_unchanged(self):
        for raw, fragment in INVALID:
            with self.subTest(raw=raw):
                host, error = normalize_domain(raw)
                self.assertEqual(host, "", f"accepted unexpectedly: {raw!r}")
                self.assertTrue(error)
                self.assertIn(fragment, error)

    def test_wildcard_does_not_bypass_userinfo_check(self):
        host, error = normalize_domain("https://user:pass@*.example.com/")

        self.assertEqual(host, "")
        self.assertIn("用户信息", error)


class ParseDomainTests(unittest.TestCase):
    def test_valid_target_reports_wildcard(self):
        target = parse_domain("https://*.Example.com/")

        self.assertIsInstance(target, DomainTarget)
        self.assertEqual(target.host, "*.example.com")
        self.assertTrue(target.wildcard)
        self.assertEqual(target.as_dict(), {"host": "*.example.com", "wildcard": True})

    def test_plain_target_is_not_wildcard(self):
        self.assertFalse(parse_domain("example.com").wildcard)

    def test_invalid_target_raises_input_error(self):
        with self.assertRaises(AppError) as context:
            parse_domain("exa mple.com")

        self.assertEqual(context.exception.code, ErrorCode.INPUT)
        self.assertEqual(context.exception.source, "input")
        self.assertFalse(context.exception.retryable)


if __name__ == "__main__":
    unittest.main()
