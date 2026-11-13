"""URL / 域名匹配与敏感路径规则。

从 ``main.py`` 抽出的纯函数，界面与离线测试共用。规则与原实现保持一致：
- 敏感路径模式只表示规则命中，不代表资源仍存在；
- 域名模式 ``example.com`` 同时匹配根域与子域，``*.example.com`` 等价。
"""

from __future__ import annotations

import re
from typing import Iterable, Sequence
from urllib.parse import urlparse

INTERESTING_PATTERNS = [
    r"\.bak$", r"\.backup$", r"\.old$", r"\.swp$", r"\.save$",
    r"\.sql$", r"\.sql\.gz$", r"\.db$", r"\.sqlite$",
    r"\.zip$", r"\.tar$", r"\.gz$", r"\.7z$", r"\.rar$",
    r"\.env$", r"\.ini$", r"\.config$", r"\.conf$",
    r"\.log$", r"\.git/config$", r"\.git/HEAD$",
    r"\.htaccess$", r"\.htpasswd$",
    r"wp-config\.php$", r"wp-config\.bak$",
    r"\.pem$", r"\.key$", r"\.crt$", r"\.cer$",
    r"\.DS_Store$", r"\.svn/", r"Thumbs\.db$",
    r"/admin/?$", r"/wp-admin/?$", r"/phpmyadmin/?$",
    r"/\.git/?$", r"/\.env/?$",
]

_DOMAIN_COUNT_SUFFIX = re.compile(r"\s*\(\d+\)\s*$")


def is_interesting_url(url: str) -> bool:
    """判断 URL 是否命中敏感/有趣的文件路径模式。"""
    for pattern in INTERESTING_PATTERNS:
        if re.search(pattern, url or "", re.IGNORECASE):
            return True
    return False


def extract_hostname(url: str) -> str:
    """从 URL 中提取小写 hostname，缺失协议时按 http 解析。"""
    if not url:
        return ""
    candidate = url if "://" in url else "http://" + url
    try:
        return (urlparse(candidate).hostname or "").lower()
    except Exception:
        return ""


def match_domain_pattern(hostname: str, pattern: str) -> bool:
    """域名匹配规则。

    - ``www.example.com`` → 精确匹配 hostname
    - ``example.com``     → 匹配 hostname 或 ``*.example.com``
    - ``*.example.com``   → 显式泛域，等价 ``example.com``
    """
    hostname = (hostname or "").lower()
    candidate = (pattern or "").strip().lower()
    candidate = candidate.replace("https://", "").replace("http://", "").rstrip("/")
    candidate = candidate.lstrip("*.")
    if not hostname or not candidate:
        return False
    if hostname == candidate:
        return True
    return hostname.endswith("." + candidate)


def match_domain_patterns(
    url: str,
    include_patterns: Sequence[str],
    exclude_patterns: Sequence[str],
) -> bool:
    """组合 include / exclude 域名匹配；exclude 优先，include 为空则放行。"""
    hostname = extract_hostname(url)
    if not hostname:
        return True

    for pattern in exclude_patterns:
        if match_domain_pattern(hostname, pattern):
            return False

    if not include_patterns:
        return True

    return any(match_domain_pattern(hostname, pattern) for pattern in include_patterns)


def strip_domain_count_suffix(value: str) -> str:
    """去掉下拉框里 ``host (N)`` 的数量后缀。"""
    return _DOMAIN_COUNT_SUFFIX.sub("", value or "").strip()


def split_terms(raw: str) -> tuple[list[str], list[str]]:
    """把逗号分隔的筛选输入拆成 (包含项, 排除项)，``!`` 前缀表示排除。

    原值不做大小写处理，由各筛选字段自行决定是否忽略大小写。
    """
    includes: list[str] = []
    excludes: list[str] = []
    for term in (raw or "").split(","):
        term = term.strip()
        if not term:
            continue
        if term.startswith("!"):
            term = term[1:].strip()
            if term:
                excludes.append(term)
        else:
            includes.append(term)
    return includes, excludes


def normalize_patterns(patterns: Iterable[str]) -> list[str]:
    """统一域名模式写法，便于去重和比较。"""
    normalized: list[str] = []
    for pattern in patterns:
        pattern = strip_domain_count_suffix(pattern).lower()
        pattern = pattern.replace("https://", "").replace("http://", "").rstrip("/")
        pattern = pattern.lstrip("*.")
        if pattern:
            normalized.append(pattern)
    return normalized
