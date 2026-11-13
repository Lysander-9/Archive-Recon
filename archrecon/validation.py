"""目标域名的规范化与严格校验。

与 ``main.ArchiveSearchApp._normalize_domain`` 保持相同的 ``(host, error)`` 契约，
可直接替换该静态方法；额外拒绝两类基线会误接受的输入：

- 用户信息（``user:pass@example.com``、``https://user:pass@example.com/``）；
- 域名内部空白（``exa mple.com``、``example .com``）。

允许的写法与基线一致：裸域、``*.`` 通配、带 http/https 协议、末尾 ``/``、
大小写混写，以及首尾空白（会被去除）。路径、查询、片段、端口、空值、无效
标签继续被拒绝，不改变既有错误提示的语义。
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit

from .errors import AppError, ErrorCode

EMPTY_MESSAGE = "请输入目标域名后再开始查询。"
WHITESPACE_MESSAGE = "域名中不能包含空白字符，请检查后重试。"
USERINFO_MESSAGE = "请移除用户信息（user:pass@），只输入域名。"
FORMAT_MESSAGE = "域名格式无效，请输入 example.com 或 *.example.com。"
PATH_MESSAGE = "这里只接受域名，不接受路径、查询参数或片段。"
PORT_FORMAT_MESSAGE = "端口格式无效；查询目标请只填写域名。"
PORT_MESSAGE = "请移除端口号，只输入域名，例如 example.com。"
IDNA_MESSAGE = "域名中包含无效字符，请检查后重试。"
LABEL_MESSAGE = "域名格式无效，请检查各级域名标签。"


@dataclass(frozen=True)
class DomainTarget:
    """校验通过的目标域名。"""

    host: str
    wildcard: bool = False

    @property
    def value(self) -> str:
        return self.host

    def as_dict(self) -> dict:
        return {"host": self.host, "wildcard": self.wildcard}


def normalize_domain(value: str) -> tuple[str, str | None]:
    """返回 ``(规范化 host, 错误提示)``；校验失败时 host 为空串。"""
    value = (value or "").strip()
    if not value:
        return "", EMPTY_MESSAGE
    if any(character.isspace() for character in value):
        return "", WHITESPACE_MESSAGE

    candidate = value if "://" in value else "https://" + value
    parsed = urlsplit(candidate)
    if "@" in parsed.netloc or parsed.username is not None or parsed.password is not None:
        return "", USERINFO_MESSAGE

    host = parsed.hostname or ""
    if parsed.scheme not in ("http", "https") or not host:
        return "", FORMAT_MESSAGE
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        return "", PATH_MESSAGE
    try:
        port = parsed.port
    except ValueError:
        return "", PORT_FORMAT_MESSAGE
    if port:
        return "", PORT_MESSAGE

    wildcard = (
        value.startswith("*.")
        or value.startswith("http://*.")
        or value.startswith("https://*.")
    )
    if wildcard:
        host = "*." + host.lstrip("*.")
    try:
        host.encode("idna")
    except UnicodeError:
        return "", IDNA_MESSAGE
    labels = host.lstrip("*.").split(".")
    if any(
        not label or len(label) > 63 or label.startswith("-") or label.endswith("-")
        for label in labels
    ):
        return "", LABEL_MESSAGE
    return host.lower(), None


def parse_domain(value: str) -> DomainTarget:
    """严格解析目标域名；失败抛出 :class:`AppError`（``ErrorCode.INPUT``）。"""
    host, error = normalize_domain(value)
    if error:
        raise AppError(ErrorCode.INPUT, error, source="input", retryable=False)
    return DomainTarget(host=host, wildcard=host.startswith("*."))
