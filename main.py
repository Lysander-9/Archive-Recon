"""
渗透测试辅助工具 - 网页存档信息搜集
GUI 主程序
"""

import threading
import csv
import json
import re
import os
from datetime import datetime
from tkinter import filedialog, messagebox
import tkinter as tk
from tkinter import ttk

import customtkinter as ctk

from api_client import ArchiveAPIClient, APIError

# ==================== 配置 ====================
ctk.set_appearance_mode("System")
ctk.set_default_color_theme("blue")

# 敏感/有趣的文件扩展名模式
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


def is_interesting_url(url: str) -> bool:
    """判断 URL 是否引用敏感/有趣的资源"""
    for pattern in INTERESTING_PATTERNS:
        if re.search(pattern, url, re.IGNORECASE):
            return True
    return False


# ==================== 结果表格组件 ====================
class ResultsTable(ctk.CTkFrame):
    """可复用的结果表格组件（含分页和筛选）"""

    # (key, 显示名, 宽度) — 第一列固定为行号，URL 列留最大空间
    COLUMNS = [
        ("#",           "#",        38),
        ("timestamp",   "时间",      90),
        ("status_code", "状态码",    55),
        ("length",      "长度",      60),
        ("file_type",   "文件类型",  110),
        ("url",         "URL",      750),
    ]

    def __init__(self, master, source_name: str, **kwargs):
        super().__init__(master, **kwargs)
        self.source_name = source_name
        self.all_results: list = []
        self.filtered_results: list = []
        self.page_size = 50
        self.current_page = 0
        self.sort_column = None
        self.sort_reverse = False

        self._build_ui()

    def _build_ui(self):
        """构建表格 UI"""
        # --- 设置 Treeview 样式（放大字体） ---
        style = ttk.Style()
        style.configure(
            "Treeview",
            font=("Microsoft YaHei UI", 11),
            rowheight=30,
        )
        style.configure(
            "Treeview.Heading",
            font=("Microsoft YaHei UI", 11, "bold"),
        )

        # --- 工具栏: 筛选 + 统计 ---
        self.toolbar = ctk.CTkFrame(self)
        self.toolbar.pack(fill="x", padx=5, pady=(5, 0))

        # 状态码筛选
        ctk.CTkLabel(self.toolbar, text="状态码:", font=ctk.CTkFont(size=12)).pack(side="left", padx=(5, 2))
        self.filter_status = ctk.CTkEntry(self.toolbar, width=100, placeholder_text="如 200,301,404")
        self.filter_status.pack(side="left", padx=2)

        # 文件类型筛选
        ctk.CTkLabel(self.toolbar, text="文件类型:", font=ctk.CTkFont(size=12)).pack(side="left", padx=(10, 2))
        self.filter_mime = ctk.CTkEntry(self.toolbar, width=120, placeholder_text="如 text/html")
        self.filter_mime.pack(side="left", padx=2)

        # URL 搜索
        ctk.CTkLabel(self.toolbar, text="URL搜索:", font=ctk.CTkFont(size=12)).pack(side="left", padx=(10, 2))
        self.filter_url = ctk.CTkEntry(self.toolbar, width=150, placeholder_text="关键词")
        self.filter_url.pack(side="left", padx=2)

        # 应用筛选按钮
        self.btn_filter = ctk.CTkButton(
            self.toolbar, text="筛选", width=60,
            command=self._apply_filters
        )
        self.btn_filter.pack(side="left", padx=(10, 5))

        # 清除筛选
        self.btn_clear = ctk.CTkButton(
            self.toolbar, text="清除", width=60,
            fg_color="gray", command=self._clear_filters
        )
        self.btn_clear.pack(side="left", padx=2)

        # 统计标签
        self.lbl_stats = ctk.CTkLabel(self.toolbar, text="共 0 条结果", font=ctk.CTkFont(size=12))
        self.lbl_stats.pack(side="right", padx=10)

        # --- Treeview 表格 ---
        self.tree_frame = ctk.CTkFrame(self)
        self.tree_frame.pack(fill="both", expand=True, padx=5, pady=5)

        self.tree_scroll_y = ctk.CTkScrollbar(self.tree_frame, orientation="vertical")
        self.tree_scroll_y.pack(side="right", fill="y")

        self.tree_scroll_x = ctk.CTkScrollbar(self.tree_frame, orientation="horizontal")
        self.tree_scroll_x.pack(side="bottom", fill="x")

        # 列 key 列表（用于 Treeview columns）
        columns_display = [c[0] for c in self.COLUMNS]
        self.tree = ttk.Treeview(
            self.tree_frame,
            columns=columns_display,
            show="headings",
            yscrollcommand=self.tree_scroll_y.set,
            xscrollcommand=self.tree_scroll_x.set,
        )

        self.tree_scroll_y.configure(command=self.tree.yview)
        self.tree_scroll_x.configure(command=self.tree.xview)

        # 设置列（stretch=False 防止压窄 URL 列，水平滑动条才能生效）
        for col_key, col_name, col_width in self.COLUMNS:
            if col_key == "#":
                self.tree.heading(col_key, text=col_name)
            else:
                self.tree.heading(
                    col_key, text=col_name,
                    command=lambda c=col_key: self._sort_by_column(c)
                )
            self.tree.column(col_key, width=col_width, minwidth=col_width, stretch=False, anchor="w")

        # # 列居中显示
        self.tree.column("#", anchor="center")
        self.tree.column("status_code", anchor="center")
        self.tree.column("length", anchor="e")

        self.tree.pack(fill="both", expand=True)

        # 敏感文件高亮标签
        self.tree.tag_configure("interesting", background="#fff3cd")

        # --- 分页栏 ---
        self.page_bar = ctk.CTkFrame(self)
        self.page_bar.pack(fill="x", padx=5, pady=(0, 5))

        self.btn_prev = ctk.CTkButton(
            self.page_bar, text="◀ 上一页", width=90,
            command=self._prev_page
        )
        self.btn_prev.pack(side="left", padx=5)

        self.lbl_page = ctk.CTkLabel(self.page_bar, text="第 1 页", font=ctk.CTkFont(size=12))
        self.lbl_page.pack(side="left", padx=10)

        self.btn_next = ctk.CTkButton(
            self.page_bar, text="下一页 ▶", width=90,
            command=self._next_page
        )
        self.btn_next.pack(side="left", padx=5)

        self.lbl_total_pages = ctk.CTkLabel(self.page_bar, text="", font=ctk.CTkFont(size=12))
        self.lbl_total_pages.pack(side="left", padx=5)

        # --- 导出按钮 ---
        self.btn_export = ctk.CTkButton(
            self.page_bar, text="导出 CSV", width=80,
            fg_color="#2e7d32", command=self._export_csv
        )
        self.btn_export.pack(side="right", padx=5)

        self.btn_export_json = ctk.CTkButton(
            self.page_bar, text="导出 JSON", width=80,
            fg_color="#1565c0", command=self._export_json
        )
        self.btn_export_json.pack(side="right", padx=5)

    # ==================== 数据加载 ====================

    def set_results(self, results: list):
        """设置全部结果并显示第一页（自动去重）"""
        # 去重：以 URL 为 key
        seen = {}
        for r in results:
            url = r.get("url", "")
            if url and url not in seen:
                seen[url] = r
        self.all_results = list(seen.values())
        self.filtered_results = self.all_results
        self.current_page = 0
        self._refresh_view()

    def append_results(self, results: list):
        """追加结果（用于懒加载）"""
        # 去重
        existing_urls = {r["url"] for r in self.all_results}
        new_items = [r for r in results if r["url"] not in existing_urls]
        self.all_results.extend(new_items)
        self.filtered_results = self.all_results
        self._refresh_view()

    # ==================== 筛选 ====================

    def _apply_filters(self):
        """应用筛选条件"""
        status_filter = self.filter_status.get().strip()
        mime_filter = self.filter_mime.get().strip()
        url_filter = self.filter_url.get().strip().lower()

        filtered = self.all_results

        if status_filter:
            statuses = {s.strip() for s in status_filter.split(",")}
            filtered = [
                r for r in filtered
                if str(r.get("status_code", "")) in statuses
            ]

        if mime_filter:
            filtered = [
                r for r in filtered
                if mime_filter.lower() in r.get("file_type", "").lower()
            ]

        if url_filter:
            filtered = [
                r for r in filtered
                if url_filter in r.get("url", "").lower()
            ]

        self.filtered_results = filtered
        self.current_page = 0
        self._refresh_view()

    def _clear_filters(self):
        """清除筛选条件"""
        self.filter_status.delete(0, "end")
        self.filter_mime.delete(0, "end")
        self.filter_url.delete(0, "end")
        self.filtered_results = self.all_results
        self.current_page = 0
        self._refresh_view()

    # ==================== 排序 ====================

    def _sort_by_column(self, column: str):
        """按列排序"""
        if column == "#":
            return  # 序号列不可排序

        if self.sort_column == column:
            self.sort_reverse = not self.sort_reverse
        else:
            self.sort_column = column
            self.sort_reverse = False

        def sort_key(item):
            val = item.get(column, "")
            if column == "length":
                try:
                    return int(val)
                except (ValueError, TypeError):
                    return 0
            if column == "status_code":
                try:
                    return int(val)
                except (ValueError, TypeError):
                    return 0
            return str(val).lower()

        self.filtered_results.sort(key=sort_key, reverse=self.sort_reverse)
        self.current_page = 0
        self._update_heading_arrows()
        self._refresh_view()

    def _update_heading_arrows(self):
        """更新列标题的排序箭头"""
        for col_key, col_name, _ in self.COLUMNS:
            if col_key == "#":
                continue  # 序号列不加箭头
            if col_key == self.sort_column:
                arrow = " ▲" if not self.sort_reverse else " ▼"
            else:
                arrow = ""
            self.tree.heading(col_key, text=col_name + arrow)

    # ==================== 分页 ====================

    def _prev_page(self):
        if self.current_page > 0:
            self.current_page -= 1
            self._refresh_view()

    def _next_page(self):
        total_pages = max(1, (len(self.filtered_results) - 1) // self.page_size + 1)
        if self.current_page < total_pages - 1:
            self.current_page += 1
            self._refresh_view()

    def _refresh_view(self):
        """刷新表格显示"""
        # 清空
        for item in self.tree.get_children():
            self.tree.delete(item)

        start = self.current_page * self.page_size
        end = start + self.page_size
        page_data = self.filtered_results[start:end]

        # 数据列 key（去掉 # 列）
        data_keys = [c[0] for c in self.COLUMNS if c[0] != "#"]

        for i, record in enumerate(page_data):
            row_num = start + i + 1  # 全局行号
            values = [row_num] + [record.get(k, "") for k in data_keys]
            tags = ()
            if is_interesting_url(record.get("url", "")):
                tags = ("interesting",)
            self.tree.insert("", "end", values=values, tags=tags)

        total = len(self.filtered_results)
        total_pages = max(1, (total - 1) // self.page_size + 1) if total > 0 else 1

        self.lbl_stats.configure(text=f"共 {total} 条结果（总计 {len(self.all_results)} 条）")
        self.lbl_page.configure(text=f"第 {self.current_page + 1} 页")
        self.lbl_total_pages.configure(text=f"/ 共 {total_pages} 页")

        self.btn_prev.configure(state="normal" if self.current_page > 0 else "disabled")
        self.btn_next.configure(
            state="normal" if self.current_page < total_pages - 1 else "disabled"
        )

    # ==================== 导出 ====================

    @property
    def _data_columns(self):
        """数据列（不含 # 序号列）"""
        return [c for c in self.COLUMNS if c[0] != "#"]

    def _export_csv(self):
        filepath = filedialog.asksaveasfilename(
            defaultextension=".csv",
            filetypes=[("CSV 文件", "*.csv")],
            initialfile=f"{self.source_name}_results.csv",
        )
        if not filepath:
            return

        try:
            fieldnames = [c[0] for c in self._data_columns]
            with open(filepath, "w", newline="", encoding="utf-8-sig") as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                for record in self.filtered_results:
                    writer.writerow({k: record.get(k, "") for k in fieldnames})
            messagebox.showinfo("导出成功", f"已导出到:\n{filepath}")
        except Exception as e:
            messagebox.showerror("导出失败", str(e))

    def _export_json(self):
        filepath = filedialog.asksaveasfilename(
            defaultextension=".json",
            filetypes=[("JSON 文件", "*.json")],
            initialfile=f"{self.source_name}_results.json",
        )
        if not filepath:
            return

        try:
            fieldnames = [c[0] for c in self._data_columns]
            export_data = []
            for record in self.filtered_results:
                export_data.append({k: record.get(k, "") for k in fieldnames})
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(export_data, f, ensure_ascii=False, indent=2)
            messagebox.showinfo("导出成功", f"已导出到:\n{filepath}")
        except Exception as e:
            messagebox.showerror("导出失败", str(e))


# ==================== Common Crawl 时间选择面板 ====================
class CCTimeSelector(ctk.CTkFrame):
    """Common Crawl 时间范围选择器"""

    def __init__(self, master, on_query_callback, **kwargs):
        super().__init__(master, **kwargs)
        self.on_query = on_query_callback
        self._build_ui()

    def _build_ui(self):
        ctk.CTkLabel(self, text="时间范围:", font=ctk.CTkFont(weight="bold")).pack(
            side="left", padx=(10, 5)
        )

        # 模式选择
        self.time_mode = ctk.StringVar(value="recent")
        modes = [
            ("最近几个月", "recent"),
            ("指定年月", "specific"),
            ("全部时间", "all"),
        ]
        for text, value in modes:
            rb = ctk.CTkRadioButton(
                self, text=text, variable=self.time_mode, value=value,
                command=self._on_mode_change
            )
            rb.pack(side="left", padx=5)

        # 最近 N 个月
        self.recent_frame = ctk.CTkFrame(self, fg_color="transparent")
        self.recent_frame.pack(side="left", padx=10)
        ctk.CTkLabel(self.recent_frame, text="过去").pack(side="left")
        self.recent_months = ctk.CTkEntry(self.recent_frame, width=50, placeholder_text="3")
        self.recent_months.pack(side="left", padx=2)
        self.recent_months.insert(0, "3")
        ctk.CTkLabel(self.recent_frame, text="个月").pack(side="left")

        # 指定年月
        self.specific_frame = ctk.CTkFrame(self, fg_color="transparent")

        now = datetime.now()
        self.specific_year = ctk.CTkOptionMenu(
            self.specific_frame,
            values=[str(y) for y in range(now.year, 2012, -1)],
            width=80,
        )
        self.specific_year.pack(side="left", padx=2)
        ctk.CTkLabel(self.specific_frame, text="年").pack(side="left")
        self.specific_month = ctk.CTkOptionMenu(
            self.specific_frame,
            values=[f"{m:02d}" for m in range(1, 13)],
            width=60,
        )
        self.specific_month.set(f"{now.month:02d}")
        self.specific_month.pack(side="left", padx=2)
        ctk.CTkLabel(self.specific_frame, text="月").pack(side="left")

    def _on_mode_change(self):
        mode = self.time_mode.get()
        if mode == "recent":
            self.recent_frame.pack(side="left", padx=10)
            self.specific_frame.pack_forget()
        elif mode == "specific":
            self.recent_frame.pack_forget()
            self.specific_frame.pack(side="left", padx=10)
        else:  # all
            self.recent_frame.pack_forget()
            self.specific_frame.pack_forget()

    def get_query_params(self) -> dict:
        """获取当前选择的时间查询参数"""
        mode = self.time_mode.get()
        if mode == "recent":
            try:
                months = int(self.recent_months.get())
            except ValueError:
                months = 3
            return {"months": months}
        elif mode == "specific":
            year = int(self.specific_year.get())
            month = int(self.specific_month.get())
            return {"from_year": year, "from_month": month}
        else:
            return {}


# ==================== 主窗口 ====================
class ArchiveSearchApp(ctk.CTk):
    """主应用程序窗口"""

    def __init__(self):
        super().__init__()

        self.title("渗透测试信息搜集工具 - Wayback Machine & Common Crawl")
        self.geometry("1400x850")
        self.minsize(1000, 600)

        # API 客户端（默认无代理）
        self.client = ArchiveAPIClient()

        # 查询控制
        self._stop_event = threading.Event()
        self._query_thread = None

        # Common Crawl 查询状态
        self.cc_querying = False
        self.cc_current_page = 0
        self.cc_index_ids = []
        self.cc_page_size = 50

        self._build_ui()

    def _build_ui(self):
        """构建主界面"""
        # --- 顶部输入区 ---
        self.top_bar = ctk.CTkFrame(self)
        self.top_bar.pack(fill="x", padx=10, pady=(10, 5))

        # 域名输入
        ctk.CTkLabel(self.top_bar, text="目标域名:", font=ctk.CTkFont(weight="bold")).pack(
            side="left", padx=(10, 5)
        )
        self.entry_domain = ctk.CTkEntry(
            self.top_bar, width=300, placeholder_text="如 *.example.com 或 example.com"
        )
        self.entry_domain.pack(side="left", padx=5)

        # 代理配置
        ctk.CTkLabel(self.top_bar, text="代理:").pack(side="left", padx=(15, 5))
        self.entry_proxy = ctk.CTkEntry(
            self.top_bar, width=200, placeholder_text="http://127.0.0.1:8080"
        )
        self.entry_proxy.pack(side="left", padx=5)

        self.btn_apply_proxy = ctk.CTkButton(
            self.top_bar, text="应用代理", width=80,
            command=self._apply_proxy
        )
        self.btn_apply_proxy.pack(side="left", padx=5)

        # 查询按钮
        self.btn_query = ctk.CTkButton(
            self.top_bar, text="开始查询", width=100,
            fg_color="#2e7d32", font=ctk.CTkFont(weight="bold"),
            command=self._start_query
        )
        self.btn_query.pack(side="right", padx=10)

        # 停止按钮（初始隐藏）
        self.btn_stop = ctk.CTkButton(
            self.top_bar, text="停止", width=80,
            fg_color="#c62828", command=self._stop_query
        )

        # 状态指示
        self.lbl_status = ctk.CTkLabel(self.top_bar, text="就绪", text_color="gray")
        self.lbl_status.pack(side="right", padx=10)

        self.progress = ctk.CTkProgressBar(self.top_bar, width=150)
        self.progress.pack(side="right", padx=10)
        self.progress.set(0)

        # --- 选项卡 ---
        self.tabview = ctk.CTkTabview(self)
        self.tabview.pack(fill="both", expand=True, padx=10, pady=5)

        self.tab_wayback = self.tabview.add("Wayback Machine")
        self.tab_commoncrawl = self.tabview.add("Common Crawl")

        # Wayback Machine 表格
        self.wayback_table = ResultsTable(self.tab_wayback, "wayback")
        self.wayback_table.pack(fill="both", expand=True)

        # Common Crawl 面板
        self._build_cc_panel()

    def _build_cc_panel(self):
        """构建 Common Crawl 面板"""
        # 时间选择器
        self.cc_time_selector = CCTimeSelector(
            self.tab_commoncrawl, on_query_callback=self._start_cc_query
        )
        self.cc_time_selector.pack(fill="x", padx=5, pady=5)

        # 已选索引显示
        self.cc_info_frame = ctk.CTkFrame(self.tab_commoncrawl, fg_color="transparent")
        self.cc_info_frame.pack(fill="x", padx=5)
        self.lbl_cc_indexes = ctk.CTkLabel(
            self.cc_info_frame, text="待查询索引: -", text_color="gray"
        )
        self.lbl_cc_indexes.pack(side="left", padx=5)

        # 结果表格
        self.cc_table = ResultsTable(self.tab_commoncrawl, "commoncrawl")
        self.cc_table.pack(fill="both", expand=True)

        # 绑定滚轮事件实现懒加载
        self.cc_table.tree.bind("<MouseWheel>", self._on_cc_scroll)

    # ==================== 代理 ====================

    def _apply_proxy(self):
        proxy = self.entry_proxy.get().strip()
        if proxy:
            self.client.set_proxy(proxy)
            self.lbl_status.configure(text=f"代理已设置: {proxy}", text_color="green")
        else:
            self.client.set_proxy(None)
            self.lbl_status.configure(text="代理已清除", text_color="gray")

    # ==================== 查询控制 ====================

    def _query_starting(self):
        """进入查询状态"""
        self._stop_event.clear()
        self.btn_query.configure(state="disabled", text="查询中...")
        self.btn_stop.pack(side="right", padx=5)  # 显示停止按钮

    def _query_done(self):
        """退出查询状态"""
        self.btn_stop.pack_forget()  # 隐藏停止按钮
        self.btn_query.configure(state="normal", text="开始查询")
        self.progress.stop()
        self.progress.set(0)

    def _stop_query(self):
        """停止当前查询"""
        self._stop_event.set()
        self.lbl_status.configure(text="正在停止...", text_color="#e65100")
        self.btn_stop.configure(state="disabled", text="停止中...")

    # ==================== 查询 Wayback Machine ====================

    def _start_query(self):
        """开始查询"""
        domain = self.entry_domain.get().strip()
        if not domain:
            messagebox.showwarning("输入错误", "请输入目标域名")
            return

        domain = domain.replace("https://", "").replace("http://", "").rstrip("/")

        self._query_starting()
        self.wayback_table.set_results([])  # 清空旧结果
        self.tabview.set("Wayback Machine")
        self.lbl_status.configure(text="正在查询 Wayback Machine (第 1 页)...", text_color="#1565c0")

        self._query_thread = threading.Thread(
            target=self._do_wayback_query, args=(domain,), daemon=True
        )
        self._query_thread.start()

    def _do_wayback_query(self, domain: str):
        """后台线程：逐页查询并实时推送结果"""
        import time as _time
        total = 0
        stop = self._stop_event
        client = self.client

        try:
            for page in range(20):  # 最多 20 页（每页 50 条 = 最多 1000 条）
                if stop.is_set():
                    self.after(0, lambda: self.lbl_status.configure(
                        text=f"Wayback Machine 已停止 (已获取 {total} 条)", text_color="#e65100"
                    ))
                    self.after(0, self._query_done)
                    return

                try:
                    result = client.query_wayback(
                        domain=domain, page=page, page_size=50, match_type="domain"
                    )
                except APIError as e:
                    # 如果已获取了一些结果，保留它们而不是显示错误
                    if total > 0:
                        self.after(0, lambda: self.lbl_status.configure(
                            text=f"Wayback Machine 中断 (已获取 {total} 条)", text_color="#e65100"
                        ))
                        self.after(0, self._query_done)
                    else:
                        self.after(0, lambda msg=str(e): self._on_query_error(msg))
                    return

                batch = result.get("results", [])
                if not batch:
                    break

                # 实时推送到主线程
                self.after(0, lambda b=batch, p=page, t=len(batch): self._on_wayback_batch(b, p, t))
                total += len(batch)

                if not result.get("has_more", False):
                    break

                # 页间短暂延迟，避免触发服务端限流
                if not stop.is_set():
                    _time.sleep(0.4)

            if not stop.is_set():
                self.after(0, lambda: self._on_wayback_done(total, domain))

        except Exception as e:
            if not stop.is_set():
                if total > 0:
                    self.after(0, self._query_done)
                else:
                    self.after(0, lambda msg=str(e): self._on_query_error(msg))

    def _on_wayback_batch(self, batch: list, page: int, count: int):
        """收到一页结果，即时追加到表格"""
        if self._stop_event.is_set():
            return
        self.wayback_table.append_results(batch)
        total = len(self.wayback_table.all_results)
        self.lbl_status.configure(
            text=f"Wayback Machine: 已获取 {total} 条 (第 {page + 1} 页)", text_color="#1565c0"
        )

    def _on_wayback_done(self, total: int, domain: str):
        """Wayback 查询完成"""
        self._query_done()
        self.wayback_table.current_page = 0
        self.wayback_table._refresh_view()
        self.lbl_status.configure(
            text=f"Wayback Machine 完成: {total} 条结果", text_color="green"
        )

    def _on_query_error(self, error_msg: str):
        """查询出错"""
        self._query_done()
        self.lbl_status.configure(text="查询失败", text_color="red")
        # 简化 SSL 相关错误提示
        if "SSL" in error_msg or "EOF" in error_msg:
            hint = (
                "连接被服务端重置，可能原因：\n"
                "1. 请求过于频繁，触发限流（已自动添加页间延迟）\n"
                "2. 代理连接不稳定，请检查代理设置\n"
                "3. 网络环境限制，请重试"
            )
        else:
            hint = error_msg
        messagebox.showerror("查询失败", hint)

    # ==================== 查询 Common Crawl ====================

    def _start_cc_query(self):
        """开始 Common Crawl 查询"""
        domain = self.entry_domain.get().strip()
        if not domain:
            messagebox.showwarning("输入错误", "请输入目标域名后再查询 Common Crawl")
            return

        domain = domain.replace("https://", "").replace("http://", "").rstrip("/")

        try:
            params = self.cc_time_selector.get_query_params()
            index_ids = self.client.get_indexes_for_period(**params)
        except APIError as e:
            messagebox.showerror("获取索引失败", str(e))
            return

        if not index_ids:
            messagebox.showinfo("无匹配索引", "所选时间范围内没有可用的 Common Crawl 索引")
            return

        self._stop_event.clear()
        self.cc_index_ids = index_ids
        self.cc_current_page = 0
        self.cc_table.set_results([])

        self.lbl_cc_indexes.configure(
            text=f"待查询索引: {len(index_ids)} 个 ({', '.join(index_ids[:5])}{'...' if len(index_ids) > 5 else ''})"
        )

        self._load_cc_page()

    def _load_cc_page(self):
        """加载 Common Crawl 当前索引"""
        if self.cc_querying:
            return
        if self._stop_event.is_set():
            self.lbl_status.configure(
                text=f"Common Crawl 已停止 (已获取 {len(self.cc_table.all_results)} 条)", text_color="#e65100"
            )
            return

        if self.cc_current_page >= len(self.cc_index_ids):
            self.lbl_status.configure(
                text=f"Common Crawl 全部完成: {len(self.cc_table.all_results)} 条", text_color="green"
            )
            self.progress.stop()
            self.progress.set(0)
            return

        idx_id = self.cc_index_ids[self.cc_current_page]
        self.cc_querying = True
        self.lbl_status.configure(
            text=f"查询 Common Crawl [{idx_id}]...", text_color="#1565c0"
        )
        self.progress.configure(mode="indeterminate")
        self.progress.start()

        domain = self.entry_domain.get().strip()
        domain = domain.replace("https://", "").replace("http://", "").rstrip("/")

        thread = threading.Thread(
            target=self._do_cc_page_query, args=(idx_id, domain), daemon=True
        )
        thread.start()

    def _do_cc_page_query(self, idx_id: str, domain: str):
        """后台查询单个 Common Crawl 索引"""
        try:
            all_from_idx = []
            for page_num in range(5):  # 每个索引最多 5 页（减少查询量）
                if self._stop_event.is_set():
                    break
                try:
                    result = self.client.query_commoncrawl(
                        index_id=idx_id, domain=domain,
                        page=page_num, page_size=self.cc_page_size,
                    )
                except APIError:
                    break
                if not result["results"]:
                    break
                all_from_idx.extend(result["results"])
                if not result["has_more"]:
                    break

            self.after(0, lambda: self._on_cc_page_done(idx_id, all_from_idx))
        except Exception as e:
            self.after(0, lambda: self._on_cc_page_error(idx_id, str(e)))

    def _on_cc_page_done(self, idx_id: str, results: list):
        """单个索引查询完成"""
        self.cc_querying = False
        self.progress.stop()
        self.progress.set(0)
        self.cc_current_page += 1

        self.cc_table.append_results(results)
        total = len(self.cc_table.all_results)
        self.lbl_status.configure(
            text=f"Common Crawl [{idx_id}]: +{len(results)} 条 | 总计: {total} 条",
            text_color="green",
        )

        if not self._stop_event.is_set() and self.cc_current_page < len(self.cc_index_ids):
            self._load_cc_page()
        elif self._stop_event.is_set():
            self.lbl_status.configure(
                text=f"Common Crawl 已停止 (已获取 {total} 条)", text_color="#e65100"
            )
        else:
            self.lbl_status.configure(
                text=f"Common Crawl 全部完成: {total} 条", text_color="green"
            )

    def _on_cc_page_error(self, idx_id: str, error_msg: str):
        """单个索引查询出错"""
        self.cc_querying = False
        self.progress.stop()
        self.progress.set(0)
        self.cc_current_page += 1
        self.lbl_status.configure(
            text=f"Common Crawl [{idx_id}] 查询失败: {error_msg[:50]}", text_color="red"
        )
        if not self._stop_event.is_set() and self.cc_current_page < len(self.cc_index_ids):
            self._load_cc_page()

    def _on_cc_scroll(self, event):
        """Common Crawl 表格滚动事件"""
        try:
            children = self.cc_table.tree.get_children()
            if not children:
                return
            last_visible = self.cc_table.tree.bbox(children[-1])
            if last_visible is None:
                return
            tree_height = self.cc_table.tree.winfo_height()
            if last_visible[1] + last_visible[3] >= tree_height - 50:
                if not self.cc_querying and not self._stop_event.is_set() and self.cc_current_page < len(self.cc_index_ids):
                    self._load_cc_page()
        except (IndexError, Exception):
            pass


# ==================== 入口 ====================
def main():
    app = ArchiveSearchApp()
    app.mainloop()


if __name__ == "__main__":
    main()
