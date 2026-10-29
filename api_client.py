"""
Archive API Client
支持 Wayback Machine CDX API 和 Common Crawl Index API 查询
"""

import time
import requests
import json
import re
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from urllib.parse import urlencode, quote


class ArchiveAPIClient:
    """封装对 Wayback Machine 和 Common Crawl 的 API 查询"""

    WAYBACK_CDX_URL = "https://web.archive.org/cdx/search/cdx"
    COMMONCRAWL_INDEX_BASE = "https://index.commoncrawl.org"
    COMMONCRAWL_COLLINFO = "https://index.commoncrawl.org/collinfo.json"

    def __init__(
        self,
        proxy: Optional[str] = None,
        timeout: int = 30,
        user_agent: Optional[str] = None,
        max_retries: int = 2,
    ):
        """
        Args:
            proxy: 代理地址, 如 http://127.0.0.1:8080
            timeout: 请求超时时间(秒)
            user_agent: 自定义 User-Agent
            max_retries: 最大重试次数
        """
        self.proxy = proxy
        self.timeout = timeout
        self.max_retries = max_retries
        self.user_agent = user_agent or (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0.0.0 Safari/537.36"
        )
        self.session = self._create_session()
        self._collinfo_cache: Optional[List[Dict]] = None

    def _create_session(self) -> requests.Session:
        session = requests.Session()
        session.headers.update({"User-Agent": self.user_agent})
        if self.proxy:
            session.proxies = {"http": self.proxy, "https": self.proxy}
        return session

    def set_proxy(self, proxy: Optional[str]):
        self.proxy = proxy
        if proxy:
            self.session.proxies = {"http": proxy, "https": proxy}
        else:
            self.session.proxies = {}

    def _request_with_retry(self, url: str) -> requests.Response:
        """带重试的请求"""
        last_error = None
        for attempt in range(self.max_retries):
            try:
                resp = self.session.get(url, timeout=self.timeout)
                if resp.status_code == 429:
                    wait = min(2 ** attempt * 1, 10)
                    time.sleep(wait)
                    continue
                resp.raise_for_status()
                return resp
            except requests.Timeout:
                last_error = "Request timed out"
                if attempt < self.max_retries - 1:
                    time.sleep(0.5)
            except requests.RequestException as e:
                last_error = str(e)
                if attempt < self.max_retries - 1:
                    time.sleep(0.5)
        raise APIError(f"Request failed after {self.max_retries} retries: {last_error}")

    # ==================== Wayback Machine CDX API ====================

    def query_wayback(
        self,
        domain: str,
        page: int = 0,
        page_size: int = 50,
        match_type: str = "domain",
        from_date: Optional[str] = None,
        to_date: Optional[str] = None,
        filters: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        查询 Wayback Machine CDX API

        Args:
            domain: 域名 (支持通配符)
            page: 页码 (0-based, 0=第一页)
            page_size: 每页条数
            match_type: exact | prefix | host | domain
            from_date: 起始日期 YYYYMMDD
            to_date: 结束日期 YYYYMMDD
            filters: 过滤条件, 如 ['statuscode:200', 'mimetype:text/html']

        Returns:
            {"results": [...], "total_available": N, "page": N, "page_size": N, "has_more": bool}
        """
        # 规范化域名：去除协议、路径和通配符前缀
        domain = domain.replace("https://", "").replace("http://", "")
        domain = domain.rstrip("/")
        # 对于 domain/host 匹配模式，不传 * 前缀，由 matchType 控制
        if match_type in ("domain", "host"):
            domain = domain.lstrip("*.")
        # 对于 prefix 匹配，需要 /* 后缀
        elif match_type == "prefix" and not domain.endswith("/*"):
            domain = domain.lstrip("*.") + "/*"

        # 构建参数列表（支持重复的 key）
        params_list = []
        params_list.append(("url", domain))
        params_list.append(("matchType", match_type))
        params_list.append(("output", "json"))
        params_list.append(("fl", "urlkey,timestamp,original,mimetype,statuscode,digest,length"))
        # collapse=urlkey: 按URL去重，只返回每个URL的最新快照
        params_list.append(("collapse", "urlkey"))
        params_list.append(("limit", str(page_size)))

        if from_date:
            params_list.append(("from", from_date))
        if to_date:
            params_list.append(("to", to_date))
        if page > 0:
            params_list.append(("page", str(page)))

        if filters:
            for f in filters:
                params_list.append(("filter", f))

        query_str = urlencode(params_list, safe=",:*~!=.")
        url = f"{self.WAYBACK_CDX_URL}?{query_str}"

        try:
            resp = self._request_with_retry(url)
            data = resp.json()

            if not data or len(data) < 2:
                return {
                    "results": [],
                    "total_available": 0,
                    "page": page,
                    "page_size": page_size,
                    "has_more": False,
                }

            headers = data[0]
            rows = data[1:]

            results = [self._normalize_wayback_record(dict(zip(headers, row))) for row in rows]

            return {
                "results": results,
                "total_available": len(results),
                "page": page,
                "page_size": page_size,
                "has_more": len(results) >= page_size,
            }
        except requests.RequestException as e:
            raise APIError(f"Wayback CDX query failed: {e}")

    def query_wayback_paginated(
        self,
        domain: str,
        page_size: int = 100,
        match_type: str = "domain",
        from_date: Optional[str] = None,
        to_date: Optional[str] = None,
        filters: Optional[List[str]] = None,
        max_pages: int = 200,
    ) -> List[Dict[str, Any]]:
        """分页获取全部结果"""
        all_results = []
        seen_urls = set()

        for page in range(max_pages):
            result = self.query_wayback(
                domain=domain, page=page, page_size=page_size,
                match_type=match_type, from_date=from_date, to_date=to_date,
                filters=filters,
            )
            if not result["results"]:
                break

            for rec in result["results"]:
                url = rec.get("url", "")
                if url and url not in seen_urls:
                    seen_urls.add(url)
                    all_results.append(rec)

            if not result["has_more"]:
                break

        return all_results

    # ==================== Common Crawl Index API ====================

    def get_commoncrawl_indexes(self) -> List[Dict[str, str]]:
        """获取所有可用索引列表"""
        if self._collinfo_cache:
            return self._collinfo_cache

        try:
            resp = self._request_with_retry(self.COMMONCRAWL_COLLINFO)
            self._collinfo_cache = resp.json()
            return self._collinfo_cache
        except requests.RequestException as e:
            raise APIError(f"Failed to fetch index list: {e}")

    def get_indexes_for_period(
        self,
        months: Optional[int] = None,
        from_year: Optional[int] = None,
        from_month: Optional[int] = None,
    ) -> List[str]:
        """
        获取指定时间范围内的索引 ID 列表。

        注意: CC-MAIN-YYYY-WW 中的 WW 是 ISO 周号(1-52),
        不是月份。使用 collinfo.json 中的 cdx-api 字段确定精确时间范围。
        """
        indexes = self.get_commoncrawl_indexes()

        if months is not None:
            cutoff = datetime.now() - timedelta(days=months * 30)
            cutoff_ts = int(cutoff.strftime("%Y%m"))
            result = []
            for idx in indexes:
                idx_id = idx["id"]
                match = re.match(r"CC-MAIN-(\d{4})-(\d{2})", idx_id)
                if match:
                    y, w = int(match.group(1)), int(match.group(2))
                    approx_month = y * 100 + max(1, min(12, (w - 1) // 4 + 1))
                    if approx_month >= cutoff_ts:
                        result.append(idx_id)
            return result

        if from_year is not None and from_month is not None:
            target_yyyymm = from_year * 100 + from_month
            result = []
            for idx in indexes:
                idx_id = idx["id"]
                match = re.match(r"CC-MAIN-(\d{4})-(\d{2})", idx_id)
                if match:
                    y, w = int(match.group(1)), int(match.group(2))
                    approx_month = y * 100 + max(1, min(12, (w - 1) // 4 + 1))
                    if approx_month == target_yyyymm:
                        result.append(idx_id)
            return result

        if from_year is not None:
            return [idx["id"] for idx in indexes if str(from_year) in idx["id"]]

        # All
        return [idx["id"] for idx in indexes]

    def query_commoncrawl(
        self,
        index_id: str,
        domain: str,
        page: int = 0,
        page_size: int = 5,
        filters: Optional[List[str]] = None,
        total_pages: Optional[int] = None,
    ) -> Dict[str, Any]:
        """查询 Common Crawl 指定索引"""
        if total_pages is None:
            total_pages = self.get_commoncrawl_page_count(
                index_id, domain, page_size=page_size, filters=filters,
            )
        if not domain.startswith("*"):
            domain = f"*.{domain.lstrip('.')}"

        params_list = [
            ("url", domain),
            ("output", "json"),
            ("page", str(page)),
            ("pageSize", str(page_size)),
        ]

        if filters:
            for f in filters:
                params_list.append(("filter", f))

        query_str = urlencode(params_list, safe=",:*~!=.")
        url = f"{self.COMMONCRAWL_INDEX_BASE}/{index_id}-index?{query_str}"

        try:
            resp = self._request_with_retry(url)
            raw_text = resp.text.strip()

            if not raw_text:
                return {
                    "results": [], "total_available": 0,
                    "page": page, "page_size": page_size,
                    "total_pages": total_pages,
                    "has_more": total_pages is not None and page + 1 < total_pages,
                    "index_id": index_id,
                }

            results = []
            for line in raw_text.split("\n"):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    results.append(self._normalize_cc_record(record))
                except json.JSONDecodeError:
                    continue

            return {
                "results": results,
                "total_available": len(results),
                "page": page,
                "page_size": page_size,
                "total_pages": total_pages,
                "has_more": total_pages is not None and page + 1 < total_pages,
                "index_id": index_id,
            }
        except requests.RequestException as e:
            raise APIError(f"Common Crawl query failed for {index_id}: {e}")

    def get_commoncrawl_page_count(
        self,
        index_id: str,
        domain: str,
        page_size: int = 5,
        filters: Optional[List[str]] = None,
    ) -> int:
        """Return available ZipNum pages; pageSize counts compressed blocks, not URL rows."""
        if not domain.startswith("*"):
            domain = f"*.{domain.lstrip('.')}"
        params_list = [
            ("url", domain),
            ("output", "json"),
            ("pageSize", str(page_size)),
            ("showNumPages", "true"),
        ]
        if filters:
            params_list.extend(("filter", value) for value in filters)
        query_string = urlencode(params_list, safe=":*~!=.")
        url = f"{self.COMMONCRAWL_INDEX_BASE}/{index_id}-index?{query_string}"
        try:
            response = self._request_with_retry(url)
            data = response.json()
            return max(0, int(data.get("pages", 0)))
        except (requests.RequestException, ValueError, TypeError, AttributeError) as error:
            raise APIError(f"Common Crawl page-count query failed for {index_id}: {error}")

    def query_commoncrawl_multi(
        self,
        index_ids: List[str],
        domain: str,
        page_size: int = 5,
        filters: Optional[List[str]] = None,
        max_per_index: int = 500,
    ) -> List[Dict[str, Any]]:
        """多索引分页查询"""
        all_results = []
        seen_urls = set()

        for idx_id in index_ids:
            total_pages = self.get_commoncrawl_page_count(idx_id, domain, page_size, filters)
            page = 0
            count = 0
            while page < total_pages and count < max_per_index:
                result = self.query_commoncrawl(
                    index_id=idx_id, domain=domain,
                    page=page, page_size=page_size, total_pages=total_pages, filters=filters,
                )
                if not result["results"]:
                    break
                remaining = max_per_index - count
                for record in result["results"][:remaining]:
                    url = record.get("url", "")
                    if url and url not in seen_urls:
                        seen_urls.add(url)
                        all_results.append(record)
                    elif not url:
                        all_results.append(record)
                count += len(result["results"])
                if not result["has_more"]:
                    break
                page += 1

        return all_results

    # ==================== 数据标准化 ====================

    @staticmethod
    def _fmt_timestamp(raw: str) -> str:
        """将 YYYYMMDDHHMMSS 格式化为 YYYY-MM-DD"""
        if len(raw) >= 8:
            d = raw[:8]
            return f"{d[0:4]}-{d[4:6]}-{d[6:8]}"
        return raw

    @staticmethod
    def _normalize_wayback_record(record: Dict) -> Dict[str, Any]:
        return {
            "url": record.get("original", ""),
            "status_code": record.get("statuscode", "") or "0",
            "length": record.get("length", "") or "0",
            "file_type": (record.get("mimetype", "") or "unknown").split(";")[0].strip(),
            "timestamp": ArchiveAPIClient._fmt_timestamp(record.get("timestamp", "")),
            "source": "wayback",
        }

    @staticmethod
    def _normalize_cc_record(record: Dict) -> Dict[str, Any]:
        return {
            "url": record.get("url", ""),
            "status_code": record.get("status", "") or "0",
            "length": record.get("length", "") or "0",
            "file_type": (record.get("mime", "") or "unknown").split(";")[0].strip(),
            "timestamp": ArchiveAPIClient._fmt_timestamp(record.get("timestamp", "")),
            "source": "commoncrawl",
        }


class APIError(Exception):
    """API 查询异常"""
    pass
