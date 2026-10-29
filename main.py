"""
渗透测试辅助工具 - 网页存档信息搜集
GUI 主程序
"""

import threading
from urllib.parse import urlsplit
import csv
import json
import re
import os
from datetime import datetime
from urllib.parse import urlparse
from tkinter import filedialog, messagebox
import tkinter as tk
from tkinter import ttk

import customtkinter as ctk

from api_client import ArchiveAPIClient, APIError


# ==================== 可滚动下拉组合框 ====================
class ScrollableComboBox(ctk.CTkFrame):
    """带滚动下拉列表的组合框，替换 CTkComboBox（后者下拉无滚动条）。"""

    def __init__(self, master, values=None, width=140, command=None, **kwargs):
        fg_color = kwargs.pop("fg_color", COLORS["surface_alt"])
        corner_radius = kwargs.pop("corner_radius", 8)
        border_width = kwargs.pop("border_width", 1)
        border_color = kwargs.pop("border_color", COLORS["border"])
        text_color = kwargs.pop("text_color", COLORS["text"])
        font = kwargs.pop("font", ctk.CTkFont(family=FONT_FAMILY, size=12))
        super().__init__(master, fg_color=fg_color, corner_radius=corner_radius,
                         border_width=border_width, border_color=border_color,
                         width=width, height=34, **kwargs)

        self._values = list(values) if values else [""]
        self._command = command
        self._dropdown_win = None
        self._dropdown_open = False
        self._combo_width = width
        self._pending_close = False

        # 输入框
        self._entry = ctk.CTkEntry(
            self, border_width=0, fg_color="transparent",
            text_color=text_color, font=font,
        )
        self._entry.pack(side="left", fill="both", expand=True, padx=(8, 0), pady=2)

        # 下拉箭头
        self._arrow_btn = ctk.CTkButton(
            self, text="▾", width=26, height=26,
            fg_color="transparent", hover_color=COLORS["border"],
            text_color=COLORS["muted"], font=(FONT_FAMILY, 10),
            command=self._toggle_dropdown,
        )
        self._arrow_btn.pack(side="right", padx=(0, 3), pady=2)

        # 点击输入框也弹出下拉
        self._entry.bind("<Button-1>", lambda e: self._toggle_dropdown())
        self.pack_propagate(False)

    # ---- API 兼容 CTkComboBox ----
    def get(self):
        return self._entry.get()

    def set(self, value):
        self._entry.delete(0, "end")
        if value:
            self._entry.insert(0, str(value))

    def configure(self, **kwargs):
        if "values" in kwargs:
            self._values = list(kwargs.pop("values"))
        if "command" in kwargs:
            self._command = kwargs.pop("command")
        if "width" in kwargs:
            self._combo_width = kwargs.pop("width")
        super().configure(**kwargs)

    # ---- 下拉逻辑 ----
    def _toggle_dropdown(self):
        if self._pending_close:
            self._pending_close = False
            return
        if self._dropdown_open:
            self._close_dropdown()
        else:
            self._open_dropdown()

    def _open_dropdown(self):
        if not self._values:
            return
        self._close_dropdown()

        self._dropdown_win = ctk.CTkToplevel(self)
        self._dropdown_win.overrideredirect(True)
        self._dropdown_win.attributes("-topmost", True)
        self._dropdown_win.configure(fg_color=("gray95", "gray17"))

        x = self.winfo_rootx()
        y = self.winfo_rooty() + self.winfo_height()

        # 下拉窗口宽度：取组合框宽度和最长条目宽度的较大值，避免截断
        import tkinter.font as tkfont
        try:
            font_obj = tkfont.Font(family="Microsoft YaHei UI", size=12)
            max_text = max(
                (font_obj.measure(str(v) if v else "（全部）") for v in self._values),
                default=0,
            )
            w = max(self._combo_width, max_text + 36)
        except Exception:
            w = self._combo_width

        item_h = 28
        max_visible = 10
        content_h = max(40, item_h * len(self._values))
        visible_h = min(content_h, item_h * max_visible)
        self._dropdown_win.geometry(f"{int(w)}x{visible_h}+{x}+{y}")

        scroll_frame = ctk.CTkScrollableFrame(
            self._dropdown_win, width=int(w), height=visible_h,
            fg_color=("gray95", "gray17"), corner_radius=0,
        )
        scroll_frame.pack(fill="both", expand=True)

        for val in self._values:
            label = str(val) if val else "（全部）"
            btn = ctk.CTkButton(
                scroll_frame, text=label, anchor="w",
                fg_color="transparent", text_color=("gray10", "gray90"),
                hover_color=("gray75", "gray35"),
                corner_radius=0, height=26,
                command=lambda v=val: self._select(v),
            )
            btn.pack(fill="x", padx=2, pady=1)

        self._dropdown_open = True
        self.after(80, self._grab_global)

    def _grab_global(self):
        """全局捕获点击，点外部关闭下拉"""
        if not self._dropdown_win:
            return
        self._dropdown_win.grab_set_global()
        self._dropdown_win.bind("<Button-1>", lambda e: self._on_dropdown_click(e), add="+")
        self._dropdown_win.bind("<Escape>", lambda e: self._close_dropdown(), add="+")
        self._dropdown_win.focus_set()

    def _on_dropdown_click(self, event):
        """由于 grab_set_global，所有点击都进入此回调。
        判断点击是否在下拉窗口范围内：在内则放行给按钮处理，在外则关闭。"""
        x, y = event.x_root, event.y_root
        if self._dropdown_win:
            dx = self._dropdown_win.winfo_rootx()
            dy = self._dropdown_win.winfo_rooty()
            dw = self._dropdown_win.winfo_width()
            dh = self._dropdown_win.winfo_height()
            # 点击在下拉窗口内 → 放行，让按钮 command 处理
            if dx <= x <= dx + dw and dy <= y <= dy + dh:
                return
        # 点击在下拉窗口外 → 关闭
        self._close_dropdown()

    def _select(self, value):
        self.set(str(value) if value else "")
        self._pending_close = True
        self._close_dropdown()
        if self._command:
            self._command(value if value else "")

    def _close_dropdown(self):
        if self._dropdown_win:
            try:
                self._dropdown_win.grab_release()
                self._dropdown_win.destroy()
            except Exception:
                pass
            self._dropdown_win = None
        self._dropdown_open = False
        self._pending_close = True
        # 延迟重置，防重复触发
        self.after(150, lambda: setattr(self, '_pending_close', False))


# ==================== 配置 ====================
ctk.set_appearance_mode("System")
ctk.set_default_color_theme("blue")

# ==================== 视觉主题（仅影响界面呈现） ====================
COLORS = {
    "page": ("#F4F7FB", "#0E1523"),
    "surface": ("#FFFFFF", "#172033"),
    "surface_alt": ("#F7F9FC", "#111A2B"),
    "border": ("#DDE4EE", "#2B3850"),
    "text": ("#162033", "#F3F6FC"),
    "muted": ("#637083", "#9AA8BC"),
    "primary": ("#2563EB", "#3B82F6"),
    "primary_hover": ("#1D4ED8", "#60A5FA"),
    "success": ("#16825D", "#22A06B"),
    "success_hover": ("#116B4D", "#34B27B"),
    "danger": ("#D13C4B", "#E05260"),
    "danger_hover": ("#B72F3D", "#F06470"),
    "warning_bg": ("#FFF4CF", "#4A3917"),
}
FONT_FAMILY = "Microsoft YaHei UI"

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
        self.current_font_size = 11
        self.empty_message = "输入目标域名并开始查询\n结果会显示在这里"

        self._build_ui()

    def _build_ui(self):
        """构建表格 UI"""
        # --- 设置 Treeview 样式 ---
        self._apply_tree_style()

        # --- 工具栏: 响应式双行筛选区 ---
        self.toolbar = ctk.CTkFrame(
            self, fg_color=COLORS["surface"], corner_radius=12,
            border_width=1, border_color=COLORS["border"],
        )
        self.toolbar.pack(fill="x", padx=8, pady=(8, 0))
        self.toolbar.grid_columnconfigure(0, weight=1)

        filter_row = ctk.CTkFrame(self.toolbar, fg_color="transparent")
        filter_row.grid(row=0, column=0, sticky="ew", padx=10, pady=(10, 6))
        for col in (1, 3, 5, 7):
            filter_row.grid_columnconfigure(col, weight=1)

        label_font = ctk.CTkFont(family=FONT_FAMILY, size=12, weight="bold")
        ctk.CTkLabel(filter_row, text="状态码", text_color=COLORS["muted"], font=label_font).grid(
            row=0, column=0, sticky="w", padx=(0, 6)
        )
        self.filter_status = ScrollableComboBox(
            filter_row, width=100,
            values=["", "200", "301", "302", "304", "307", "308",
                    "400", "401", "403", "404", "405",
                    "500", "502", "503"],
        )
        self.filter_status.set("")
        self.filter_status.grid(row=0, column=1, sticky="ew", padx=(0, 14))

        ctk.CTkLabel(filter_row, text="文件类型", text_color=COLORS["muted"], font=label_font).grid(
            row=0, column=2, sticky="w", padx=(0, 6)
        )
        self.filter_mime = ScrollableComboBox(
            filter_row, width=160,
            values=["", "text/html", "text/css", "text/javascript",
                    "application/json", "application/xml", "application/pdf",
                    "application/zip", "image/png", "image/jpeg",
                    "text/plain", "application/octet-stream"],
        )
        self.filter_mime.set("")
        self.filter_mime.grid(row=0, column=3, sticky="ew", padx=(0, 14))

        ctk.CTkLabel(filter_row, text="URL 搜索", text_color=COLORS["muted"], font=label_font).grid(
            row=0, column=4, sticky="w", padx=(0, 6)
        )
        self.filter_url = ctk.CTkEntry(
            filter_row, height=34, placeholder_text="关键词，!关键词可排除",
            fg_color=COLORS["surface_alt"], border_color=COLORS["border"],
        )
        self.filter_url.grid(row=0, column=5, sticky="ew", padx=(0, 14))

        self.filter_advanced = ctk.CTkFrame(self.toolbar, fg_color="transparent")
        self.filter_advanced.grid(row=1, column=0, sticky="ew", padx=10, pady=(0, 6))
        ctk.CTkLabel(self.filter_advanced, text="域名筛选", text_color=COLORS["muted"], font=label_font).pack(side="left", padx=(0, 8))
        self.filter_domain = ScrollableComboBox(
            self.filter_advanced, width=220, values=["（查询后自动填充）"],
        )
        self.filter_domain.set("")
        self.filter_domain.pack(side="left", fill="x", expand=True)
        self.filter_advanced.grid_remove()

        action_row = ctk.CTkFrame(self.toolbar, fg_color="transparent")
        action_row.grid(row=2, column=0, sticky="ew", padx=10, pady=(0, 10))

        ctk.CTkLabel(action_row, text="表格字号", text_color=COLORS["muted"], font=label_font).pack(
            side="left", padx=(0, 6)
        )
        self.font_var = ctk.StringVar(value="默认")
        self.font_menu = ctk.CTkOptionMenu(
            action_row, values=["小", "默认", "中", "大", "超大"],
            variable=self.font_var, width=84, height=34,
            fg_color=COLORS["surface_alt"], button_color=COLORS["primary"],
            button_hover_color=COLORS["primary_hover"], text_color=COLORS["text"],
            command=self._on_font_change,
        )
        self.font_menu.pack(side="left")

        self.btn_filter = ctk.CTkButton(
            action_row, text="应用筛选", width=92, height=34,
            fg_color=COLORS["primary"], hover_color=COLORS["primary_hover"],
            command=self._apply_filters,
        )
        self.btn_filter.pack(side="left", padx=(12, 6))

        self.btn_clear = ctk.CTkButton(
            action_row, text="清除条件", width=88, height=34,
            fg_color=COLORS["surface_alt"], hover_color=COLORS["border"],
            border_width=1, border_color=COLORS["border"], text_color=COLORS["text"],
            command=self._clear_filters,
        )
        self.btn_clear.pack(side="left")

        self.btn_advanced = ctk.CTkButton(
            action_row, text="高级筛选  +", width=112, height=34,
            fg_color=COLORS["surface_alt"], hover_color=COLORS["border"],
            border_width=1, border_color=COLORS["border"], text_color=COLORS["text"],
            command=self._toggle_advanced_filters,
        )
        self.btn_advanced.pack(side="left", padx=(8, 0))
        self.interesting_only = ctk.BooleanVar(value=False)
        self.chk_interesting = ctk.CTkCheckBox(
            action_row, text="敏感路径模式", variable=self.interesting_only,
            text_color=COLORS["muted"], command=self._apply_filters,
        )
        self.chk_interesting.pack(side="left", padx=(12, 4))

        self.lbl_stats = ctk.CTkLabel(
            action_row, text="0 条结果", text_color=COLORS["muted"],
            font=ctk.CTkFont(family=FONT_FAMILY, size=12),
        )
        self.lbl_stats.pack(side="right", padx=4)
        ctk.CTkLabel(
            self.toolbar, text="导出包含全部筛选匹配结果（不限当前页）",
            text_color=COLORS["muted"], font=ctk.CTkFont(family=FONT_FAMILY, size=11),
        ).grid(row=3, column=0, sticky="e", padx=14, pady=(0, 8))

        # --- Treeview 表格 ---
        self.tree_frame = ctk.CTkFrame(
            self, fg_color=COLORS["surface"], corner_radius=12,
            border_width=1, border_color=COLORS["border"],
        )
        self.tree_frame.pack(fill="both", expand=True, padx=8, pady=8)

        self.tree_scroll_y = ctk.CTkScrollbar(self.tree_frame, orientation="vertical")
        self.tree_scroll_y.pack(side="right", fill="y")

        # 列 key 列表（用于 Treeview columns）
        columns_display = [c[0] for c in self.COLUMNS]
        self.tree = ttk.Treeview(
            self.tree_frame,
            columns=columns_display,
            show="headings",
            yscrollcommand=self.tree_scroll_y.set,
        )

        self.tree_scroll_y.configure(command=self.tree.yview)

        # 设置列（URL 列 stretch=True 填满剩余空间，无水平滚动条）
        for col_key, col_name, col_width in self.COLUMNS:
            if col_key == "#":
                self.tree.heading(col_key, text=col_name)
            else:
                self.tree.heading(
                    col_key, text=col_name,
                    command=lambda c=col_key: self._sort_by_column(c)
                )
            stretch = (col_key == "url")
            self.tree.column(col_key, width=col_width, minwidth=col_width, stretch=stretch, anchor="w")

        # # 列居中显示
        self.tree.column("#", anchor="center")
        self.tree.column("status_code", anchor="center")
        self.tree.column("length", anchor="e")

        self.tree.pack(fill="both", expand=True)
        self.empty_state = ctk.CTkLabel(
            self.tree_frame, text="输入目标域名并开始查询\n结果会显示在这里",
            text_color=COLORS["muted"], justify="center",
            font=ctk.CTkFont(family=FONT_FAMILY, size=15),
        )
        self.empty_state.place(relx=0.5, rely=0.47, anchor="center")

        # 敏感文件高亮标签
        self.tree.tag_configure("interesting", background="#FFF0BA", foreground="#5A4300")

        # 复制支持: Ctrl+C / 右键菜单
        self.tree.bind("<Control-c>", lambda e: self._copy_selected())
        self.tree.bind("<Control-C>", lambda e: self._copy_selected())
        self.tree.bind("<Button-3>", self._on_right_click)
        self._ctx_menu = tk.Menu(self.tree, tearoff=0)
        self._ctx_menu.add_command(label="复制 URL", command=lambda: self._copy_selected("url"))
        self._ctx_menu.add_command(label="复制整行数据", command=lambda: self._copy_selected("row"))

        # --- 分页栏 ---
        self.page_bar = ctk.CTkFrame(
            self, fg_color=COLORS["surface"], corner_radius=12,
            border_width=1, border_color=COLORS["border"], height=50,
        )
        self.page_bar.pack(fill="x", padx=8, pady=(0, 8))

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

        # 每页行数
        ctk.CTkLabel(self.page_bar, text="每页:", font=ctk.CTkFont(size=12)).pack(side="left", padx=(15, 2))
        self.page_size_var = ctk.StringVar(value="50")
        self.page_size_menu = ctk.CTkOptionMenu(
            self.page_bar, values=["20", "50", "100", "200", "500", "1000"],
            variable=self.page_size_var, width=60,
            command=self._on_page_size_change
        )
        self.page_size_menu.pack(side="left", padx=2)

        # 跳转到指定页
        ctk.CTkLabel(self.page_bar, text="跳至:", font=ctk.CTkFont(size=12)).pack(side="left", padx=(10, 2))
        self.entry_jump = ctk.CTkEntry(self.page_bar, width=50, placeholder_text="页码")
        self.entry_jump.pack(side="left", padx=2)
        self.entry_jump.bind("<Return>", lambda e: self._jump_to_page())
        self.btn_jump = ctk.CTkButton(
            self.page_bar, text="GO", width=40,
            command=self._jump_to_page
        )
        self.btn_jump.pack(side="left", padx=2)

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
        self._update_domain_dropdown()
        self._refresh_view()

    def set_empty_message(self, message: str):
        self.empty_message = message
        if not self.filtered_results:
            self.empty_state.configure(text=message)
            self.empty_state.place(relx=0.5, rely=0.47, anchor="center")

    def append_results(self, results: list):
        """追加结果（用于懒加载）"""
        # 去重
        existing_urls = {r["url"] for r in self.all_results}
        new_items = [r for r in results if r["url"] not in existing_urls]
        self.all_results.extend(new_items)
        self.filtered_results = self.all_results
        self._update_domain_dropdown()
        self._refresh_view()

    # ==================== 筛选 ====================

    def _apply_filters(self):
        """应用筛选条件（支持排除：以 ! 开头表示排除该项）"""
        status_raw = self.filter_status.get().strip()
        mime_raw = self.filter_mime.get().strip()
        url_raw = self.filter_url.get().strip()

        filtered = self.all_results

        # --- 状态码筛选 ---
        if status_raw:
            include_codes = set()
            exclude_codes = set()
            for s in status_raw.split(","):
                s = s.strip()
                if s.startswith("!"):
                    exclude_codes.add(s[1:])
                else:
                    include_codes.add(s)
            if include_codes:
                filtered = [r for r in filtered if str(r.get("status_code", "")) in include_codes]
            if exclude_codes:
                filtered = [r for r in filtered if str(r.get("status_code", "")) not in exclude_codes]

        # --- 文件类型筛选 ---
        if mime_raw:
            include_mimes = []
            exclude_mimes = []
            for m in mime_raw.split(","):
                m = m.strip()
                if m.startswith("!"):
                    exclude_mimes.append(m[1:].lower())
                else:
                    include_mimes.append(m.lower())
            for pat in include_mimes:
                filtered = [r for r in filtered if pat in r.get("file_type", "").lower()]
            for pat in exclude_mimes:
                filtered = [r for r in filtered if pat not in r.get("file_type", "").lower()]

        # --- URL 关键词筛选 ---
        if url_raw:
            include_urls = []
            exclude_urls = []
            for u in url_raw.split(","):
                u = u.strip()
                if u.startswith("!"):
                    exclude_urls.append(u[1:].lower())
                else:
                    include_urls.append(u.lower())
            for pat in include_urls:
                filtered = [r for r in filtered if pat in r.get("url", "").lower()]
            for pat in exclude_urls:
                filtered = [r for r in filtered if pat not in r.get("url", "").lower()]

        # --- 域名筛选（ComboBox 值可能带 " (N)" 后缀，自动剥离）---
        domain_raw = self.filter_domain.get().strip()
        if domain_raw:
            # 剥离 " (N)" 后缀
            domain_raw = re.sub(r"\s*\(\d+\)\s*$", "", domain_raw).strip()
            include_domains = []
            exclude_domains = []
            for d in domain_raw.split(","):
                d = d.strip()
                if d.startswith("!"):
                    exclude_domains.append(d[1:].lower())
                else:
                    include_domains.append(d.lower())
            if include_domains or exclude_domains:
                filtered = [
                    r for r in filtered
                    if self._match_domain_patterns(r.get("url", ""), include_domains, exclude_domains)
                ]

        if self.interesting_only.get():
            filtered = [r for r in filtered if is_interesting_url(r.get("url", ""))]
        self.filtered_results = filtered
        self.current_page = 0
        self._refresh_view()

    def _clear_filters(self):
        """清除筛选条件"""
        self.filter_status.set("")
        self.filter_mime.set("")
        self.filter_url.delete(0, "end")
        self.filter_domain.set("")
        self.interesting_only.set(False)
        self.filtered_results = self.all_results
        self.current_page = 0
        self._refresh_view()

    def _toggle_advanced_filters(self):
        if self.filter_advanced.winfo_ismapped():
            self.filter_advanced.grid_remove()
            self.btn_advanced.configure(text="高级筛选  +")
        else:
            self.filter_advanced.grid()
            self.btn_advanced.configure(text="高级筛选  −")

    def _update_domain_dropdown(self):
        """从当前全量结果中提取域名并统计数量，更新下拉框。保留当前选中值。"""
        from collections import Counter
        current_val = self.filter_domain.get().strip()
        hostnames = []
        for r in self.all_results:
            hn = self._extract_hostname(r.get("url", ""))
            if hn:
                hostnames.append(hn)
        counter = Counter(hostnames)
        # 按数量降序排列，格式 "hostname (count)"，空值始终在第一项
        values = [""] + [f"{hn} ({cnt})" for hn, cnt in counter.most_common()]
        self.filter_domain.configure(values=values)
        # 如果当前选中值仍在列表中则保留，否则清空
        if current_val and current_val in values:
            self.filter_domain.set(current_val)
        else:
            self.filter_domain.set("")

    def _on_page_size_change(self, choice):
        """每页行数变更"""
        try:
            self.page_size = int(choice)
        except ValueError:
            self.page_size = 50
        self.current_page = 0
        self._refresh_view()

    def _jump_to_page(self):
        """跳转到指定页"""
        raw = self.entry_jump.get().strip()
        if not raw:
            return
        try:
            page = int(raw) - 1  # 用户输入的是 1-based
            total = len(self.filtered_results)
            total_pages = max(1, (total - 1) // self.page_size + 1) if total > 0 else 1
            if page < 0:
                page = 0
            if page >= total_pages:
                page = total_pages - 1
            self.current_page = page
            self._refresh_view()
        except ValueError:
            pass

    @staticmethod
    def _extract_hostname(url: str) -> str:
        """从 URL 中提取 hostname（小写）"""
        if "://" not in url:
            url = "http://" + url
        try:
            return urlparse(url).hostname or ""
        except Exception:
            return ""

    @staticmethod
    def _match_domain_pattern(hostname: str, pattern: str) -> bool:
        """
        域名匹配规则：
        - "www.example.com"     → 精确匹配 hostname
        - "example.com"         → 匹配 hostname 或 *.example.com（泛域）
        - "*.example.com"       → 显式泛域，同 example.com
        """
        hostname = hostname.lower()
        pattern = pattern.lower().lstrip("*.")

        # 去除协议前缀（如果有）
        pattern = pattern.replace("https://", "").replace("http://", "").rstrip("/")

        if hostname == pattern:
            return True
        if hostname.endswith("." + pattern):
            return True
        return False

    @classmethod
    def _match_domain_patterns(cls, url: str, include_patterns: list, exclude_patterns: list) -> bool:
        """
        组合 include / exclude 域名模式匹配。
        规则: include 为空 → 默认通过；exclude 优先于 include。
        """
        hostname = cls._extract_hostname(url)
        if not hostname:
            return True  # 无法解析域名时保留结果

        # exclude 优先
        for pat in exclude_patterns:
            if cls._match_domain_pattern(hostname, pat):
                return False

        # include 为空 → 全部通过
        if not include_patterns:
            return True

        for pat in include_patterns:
            if cls._match_domain_pattern(hostname, pat):
                return True
        return False

    def _apply_tree_style(self):
        """应用 Treeview 字体与主题样式"""
        style = ttk.Style()
        size = self.current_font_size
        mode = ctk.get_appearance_mode()
        dark = mode == "Dark"
        bg = "#172033" if dark else "#FFFFFF"
        field_bg = "#111A2B" if dark else "#FFFFFF"
        fg = "#F3F6FC" if dark else "#162033"
        heading_bg = "#24324A" if dark else "#EAF0F8"
        heading_fg = "#F3F6FC" if dark else "#26344A"
        selected_bg = "#1D5FD1" if dark else "#D9E8FF"
        selected_fg = "#FFFFFF" if dark else "#153D78"
        style.theme_use("clam")
        style.configure(
            "Treeview", font=(FONT_FAMILY, size), rowheight=int(size * 2.75),
            background=bg, fieldbackground=field_bg, foreground=fg,
            borderwidth=0, relief="flat",
        )
        style.map(
            "Treeview", background=[("selected", selected_bg)],
            foreground=[("selected", selected_fg)],
        )
        style.configure(
            "Treeview.Heading", font=(FONT_FAMILY, size, "bold"),
            background=heading_bg, foreground=heading_fg,
            borderwidth=0, relief="flat", padding=(8, 8),
        )
        style.map("Treeview.Heading", background=[("active", selected_bg)])

    def _on_font_change(self, choice):
        """字体缩放回调"""
        size_map = {"小": 9, "默认": 11, "中": 13, "大": 15, "超大": 18}
        self.current_font_size = size_map.get(choice, 11)
        self._apply_tree_style()
        self._refresh_view()

    def _auto_size_columns(self):
        """根据当前页内容自动调整各列 minwidth（URL 列 stretch 填满剩余空间）"""
        import tkinter.font as tkfont
        font = tkfont.Font(family="Microsoft YaHei UI", size=self.current_font_size)

        for col_key, col_name, default_w in self.COLUMNS:
            w = font.measure(col_name) + 30
            for item in self.tree.get_children():
                val = str(self.tree.set(item, col_key))
                w = max(w, font.measure(val) + 25)

            if col_key == "#":
                w = max(30, min(60, w))
            elif col_key == "url":
                w = max(200, min(950, w))
            elif col_key == "file_type":
                w = max(default_w, min(200, w))
            else:
                w = max(default_w, min(150, w))

            stretch = (col_key == "url")
            self.tree.column(col_key, minwidth=w, stretch=stretch)

    def _on_right_click(self, event):
        """右键弹出上下文菜单"""
        item = self.tree.identify_row(event.y)
        if item:
            current = self.tree.selection()
            if item not in current:
                self.tree.selection_set(item)
        try:
            self._ctx_menu.tk_popup(event.x_root, event.y_root)
        finally:
            self._ctx_menu.grab_release()

    def _copy_selected(self, mode: str = "url"):
        """复制选中行数据到剪贴板
        mode: "url" → 仅复制 URL，每行一个
              "row" → 复制整行（Tab 分隔，适合粘贴到 Excel）
        """
        selected = self.tree.selection()
        if not selected:
            return

        # 找出 URL 列的索引（跳过 # 列）
        col_keys = [c[0] for c in self.COLUMNS]
        url_idx = col_keys.index("url")

        lines = []
        for item in selected:
            values = self.tree.item(item, "values")
            if not values:
                continue
            if mode == "url":
                url = values[url_idx] if len(values) > url_idx else ""
                if url:
                    lines.append(str(url))
            else:
                # row mode: Tab 分隔，跳过 # 列
                row_data = values[1:]  # values[0] is row number
                lines.append("\t".join(str(v) for v in row_data))

        if lines:
            text = "\n".join(lines)
            self.clipboard_clear()
            self.clipboard_append(text)
            self.update()  # 保持剪贴板内容在窗口关闭后仍可用

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
        if page_data:
            self.empty_state.place_forget()
        else:
            if self.all_results:
                empty_text = "没有符合条件的结果\n清除筛选或调整关键词后重试"
            else:
                empty_text = self.empty_message
            self.empty_state.configure(text=empty_text)
            self.empty_state.place(relx=0.5, rely=0.47, anchor="center")

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

        if len(self.filtered_results) == len(self.all_results):
            self.lbl_stats.configure(text=f"共 {total:,} 条结果")
        else:
            self.lbl_stats.configure(text=f"匹配 {total:,} / 共 {len(self.all_results):,} 条")
        self.lbl_page.configure(text=f"第 {self.current_page + 1} 页")
        self.lbl_total_pages.configure(text=f"/ 共 {total_pages} 页")

        self.btn_prev.configure(state="normal" if self.current_page > 0 else "disabled")
        self.btn_next.configure(
            state="normal" if self.current_page < total_pages - 1 else "disabled"
        )

        # 自动适配列宽
        self.after(10, self._auto_size_columns)

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

        self.title("Archive Recon · 网页存档信息搜集工具")
        self.configure(fg_color=COLORS["page"])
        self._fit_window_to_desktop()

        # API 客户端（默认无代理）
        self.client = ArchiveAPIClient()

        # 查询控制
        self._stop_event = threading.Event()
        self._query_thread = None

        # Common Crawl 查询状态
        self.cc_querying = False
        self.cc_current_page = 0
        self.cc_index_ids = []
        self.cc_page_size = 5  # Common Crawl pageSize counts compressed index blocks, not URL rows.
        self.cc_failed_indexes: list[tuple[str, str]] = []
        self.cc_succeeded_indexes: list[str] = []
        self.cc_truncated_indexes: list[str] = []
        self._active_query_id = 0

        self._build_ui()
        self._apply_proxy()  # 自动应用默认代理

    def _fit_window_to_desktop(self):
        """根据当前桌面可用尺寸设置舒适的初始窗口大小并居中。"""
        screen_w = self.winfo_screenwidth()
        screen_h = self.winfo_screenheight()
        min_w = min(1080, max(880, screen_w - 80))
        min_h = min(680, max(620, screen_h - 100))
        self.minsize(min_w, min_h)
        width = min(1520, max(min_w, int(screen_w * 0.88)))
        height = min(920, max(min_h, int(screen_h * 0.86)))
        x = max(0, (screen_w - width) // 2)
        y = max(0, (screen_h - height) // 2)
        self.geometry(f"{width}x{height}+{x}+{y}")

    def _build_ui(self):
        """构建主界面"""
        # --- 品牌标题区 ---
        self.header = ctk.CTkFrame(self, fg_color="transparent")
        self.header.pack(fill="x", padx=22, pady=(18, 10))
        ctk.CTkLabel(
            self.header, text="Archive Recon", text_color=COLORS["text"],
            font=ctk.CTkFont(family=FONT_FAMILY, size=25, weight="bold"),
        ).pack(side="left")
        ctk.CTkLabel(
            self.header, text="网页历史存档信息搜集", text_color=COLORS["muted"],
            font=ctk.CTkFont(family=FONT_FAMILY, size=13),
        ).pack(side="left", padx=(12, 0), pady=(6, 0))

        # --- 顶部输入区：双行卡片布局，适配较窄桌面窗口 ---
        self.top_bar = ctk.CTkFrame(
            self, fg_color=COLORS["surface"], corner_radius=14,
            border_width=1, border_color=COLORS["border"],
        )
        self.top_bar.pack(fill="x", padx=18, pady=(0, 10))
        self.top_bar.grid_columnconfigure(1, weight=3)
        self.top_bar.grid_columnconfigure(3, weight=2)

        field_label_font = ctk.CTkFont(family=FONT_FAMILY, size=12, weight="bold")
        ctk.CTkLabel(
            self.top_bar, text="目标域名", text_color=COLORS["muted"], font=field_label_font,
        ).grid(row=0, column=0, sticky="w", padx=(16, 8), pady=(14, 8))
        self.entry_domain = ctk.CTkEntry(
            self.top_bar, height=38, placeholder_text="例如 *.example.com 或 example.com",
            fg_color=COLORS["surface_alt"], border_color=COLORS["border"],
        )
        self.entry_domain.grid(row=0, column=1, sticky="ew", padx=(0, 18), pady=(14, 8))

        self.network_toggle = ctk.CTkButton(
            self.top_bar, text="网络设置  +", width=112, height=36,
            fg_color=COLORS["surface_alt"], hover_color=COLORS["border"],
            border_width=1, border_color=COLORS["border"], text_color=COLORS["text"],
            command=self._toggle_network_settings,
        )
        self.network_toggle.grid(row=0, column=2, columnspan=3, sticky="e", padx=16, pady=(14, 8))

        self.network_settings = ctk.CTkFrame(self.top_bar, fg_color=COLORS["surface_alt"], corner_radius=10)
        ctk.CTkLabel(self.network_settings, text="代理地址", text_color=COLORS["muted"], font=field_label_font).pack(side="left", padx=(12, 8), pady=10)
        self.entry_proxy = ctk.CTkEntry(self.network_settings, height=34, placeholder_text="留空则直连", fg_color=COLORS["surface"], border_color=COLORS["border"], width=300)
        self.entry_proxy.insert(0, "http://127.0.0.1:7890")
        self.entry_proxy.pack(side="left", padx=(0, 8), pady=8)
        self.btn_apply_proxy = ctk.CTkButton(self.network_settings, text="应用代理", width=92, height=34, fg_color=COLORS["primary"], hover_color=COLORS["primary_hover"], command=self._apply_proxy)
        self.btn_apply_proxy.pack(side="left", padx=(0, 12), pady=8)
        self.network_settings.grid(row=1, column=0, columnspan=5, sticky="e", padx=12, pady=(0, 4))
        self.network_settings.grid_remove()

        status_row = ctk.CTkFrame(self.top_bar, fg_color="transparent")
        status_row.grid(row=2, column=0, columnspan=5, sticky="ew", padx=16, pady=(2, 14))

        self.lbl_status = ctk.CTkLabel(
            status_row, text="就绪", text_color=COLORS["muted"],
            font=ctk.CTkFont(family=FONT_FAMILY, size=12),
        )
        self.lbl_status.pack(side="left")

        self.progress = ctk.CTkProgressBar(
            status_row, width=150, height=7,
            progress_color=COLORS["primary"], fg_color=COLORS["border"],
        )
        self.progress.pack(side="left", padx=12)
        self.progress.set(0)

        self.btn_cc_query = ctk.CTkButton(
            status_row, text="Common Crawl 查询", width=142, height=38,
            fg_color=COLORS["primary"], hover_color=COLORS["primary_hover"],
            font=ctk.CTkFont(family=FONT_FAMILY, size=12, weight="bold"),
            command=self._start_cc_query,
        )
        self.btn_cc_query.pack(side="right")

        self.btn_wb_query = ctk.CTkButton(
            status_row, text="Wayback 查询", width=126, height=38,
            fg_color=COLORS["success"], hover_color=COLORS["success_hover"],
            font=ctk.CTkFont(family=FONT_FAMILY, size=12, weight="bold"),
            command=self._start_wayback_query,
        )
        self.btn_wb_query.pack(side="right", padx=(0, 8))

        # 停止按钮（初始隐藏，保留原有显示/隐藏逻辑）
        self.btn_stop = ctk.CTkButton(
            status_row, text="停止", width=82, height=38,
            fg_color=COLORS["danger"], hover_color=COLORS["danger_hover"],
            command=self._stop_query,
        )

        # --- 选项卡 ---
        self.tabview = ctk.CTkTabview(
            self, fg_color=COLORS["surface"], corner_radius=14,
            border_width=1, border_color=COLORS["border"],
            segmented_button_fg_color=COLORS["surface_alt"],
            segmented_button_selected_color=COLORS["primary"],
            segmented_button_selected_hover_color=COLORS["primary_hover"],
            segmented_button_unselected_color=COLORS["surface_alt"],
            segmented_button_unselected_hover_color=COLORS["border"],
            text_color=COLORS["text"],
        )
        self.tabview.pack(fill="both", expand=True, padx=18, pady=(0, 14))

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

    def _toggle_network_settings(self):
        if self.network_settings.winfo_ismapped():
            self.network_settings.grid_remove()
            self.network_toggle.configure(text="网络设置  +")
        else:
            self.network_settings.grid()
            self.network_toggle.configure(text="网络设置  −")

    def _apply_proxy(self):
        proxy = self.entry_proxy.get().strip()
        if proxy:
            self.client.set_proxy(proxy)
            self.lbl_status.configure(text="代理已应用（连通性尚未验证）", text_color=COLORS["muted"])
        else:
            self.client.set_proxy(None)
            self.lbl_status.configure(text="代理已清除", text_color="gray")

    # ==================== 查询控制 ====================

    def _query_starting(self):
        """进入查询状态"""
        self._active_query_id += 1
        self._stop_event.clear()
        self.btn_wb_query.configure(state="disabled")
        self.btn_cc_query.configure(state="disabled")
        self.btn_stop.pack(side="right", padx=5)  # 显示停止按钮

    def _query_done(self):
        """退出查询状态"""
        self.btn_stop.pack_forget()  # 隐藏停止按钮
        self.btn_stop.configure(state="normal", text="停止")
        self.btn_wb_query.configure(state="normal")
        self.btn_cc_query.configure(state="normal")
        self.progress.stop()
        self.progress.configure(mode="determinate")
        self.progress.set(0)

    def _stop_query(self):
        """停止当前查询"""
        self._stop_event.set()
        self.lbl_status.configure(text="正在停止...", text_color="#e65100")
        self.btn_stop.configure(state="disabled", text="停止中...")

    # ==================== 查询 Wayback Machine ====================

    def _start_wayback_query(self):
        """开始 Wayback Machine 查询"""
        domain = self.entry_domain.get().strip()
        domain, error = self._normalize_domain(domain)
        if error:
            self.lbl_status.configure(text=error, text_color=COLORS["danger"])
            return

        self._query_starting()
        self.wayback_table.set_results([])  # 清空旧结果
        self.wayback_table.set_empty_message("正在读取 Wayback 存档…")
        self.tabview.set("Wayback Machine")
        self.lbl_status.configure(text="Wayback Machine：每次最多读取 20 页（约 1,000 条）；更多存档可能未显示。", text_color=COLORS["primary"])

        self._query_thread = threading.Thread(
            target=self._do_wayback_query, args=(domain,), daemon=True
        )
        self._query_thread.start()

    def _do_wayback_query(self, domain: str):
        """后台线程：逐页查询并实时推送结果"""
        import time as _time
        total = 0
        reached_limit_with_more = False
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
                if page == 19 and result.get("has_more", False):
                    reached_limit_with_more = True

                # 实时推送到主线程
                self.after(0, lambda b=batch, p=page, t=len(batch): self._on_wayback_batch(b, p, t))
                total += len(batch)

                if not result.get("has_more", False):
                    break

                # 页间短暂延迟，避免触发服务端限流
                if not stop.is_set():
                    _time.sleep(0.4)

            if not stop.is_set():
                self.after(0, lambda: self._on_wayback_done(total, domain, reached_limit_with_more))

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

    def _on_wayback_done(self, total: int, domain: str, reached_limit_with_more: bool = False):
        """Wayback 查询完成"""
        self._query_done()
        self.wayback_table.current_page = 0
        self.wayback_table._refresh_view()
        if reached_limit_with_more:
            self.lbl_status.configure(
                text=f"Wayback Machine 部分完成：已读满 20 页 / {total} 条，可能仍有更多存档。",
                text_color="#B7791F",
            )
        else:
            self.lbl_status.configure(
                text=f"Wayback Machine 完成: {total} 条结果", text_color=COLORS["success"]
            )
        if total == 0:
            self.wayback_table.set_empty_message("查询完成，没有找到存档记录")

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
        domain, error = self._normalize_domain(domain)
        if error:
            self.lbl_status.configure(text=error, text_color=COLORS["danger"])
            return

        self._query_starting()
        self.cc_index_ids = []
        self.cc_current_page = 0
        self.cc_failed_indexes = []
        self.cc_succeeded_indexes = []
        self.cc_truncated_indexes = []
        self.cc_table.set_results([])
        self.cc_table.set_empty_message("正在获取 Common Crawl 索引列表…")
        self.tabview.set("Common Crawl")
        self.lbl_status.configure(text="正在获取 Common Crawl 索引列表…", text_color=COLORS["primary"])
        self.lbl_cc_indexes.configure(text="正在获取可用索引…")
        params = self.cc_time_selector.get_query_params()
        query_id = self._active_query_id
        threading.Thread(target=self._prepare_cc_query, args=(query_id, domain, params), daemon=True).start()

    @staticmethod
    def _normalize_domain(value: str) -> tuple[str, str | None]:
        """Return a normalized hostname or a user-facing validation message."""
        value = value.strip()
        if not value:
            return "", "请输入目标域名后再开始查询。"
        candidate = value if "://" in value else "https://" + value
        parsed = urlsplit(candidate)
        host = parsed.hostname or ""
        if parsed.scheme not in ("http", "https") or not host:
            return "", "域名格式无效，请输入 example.com 或 *.example.com。"
        if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            return "", "这里只接受域名，不接受路径、查询参数或片段。"
        try:
            port = parsed.port
        except ValueError:
            return "", "端口格式无效；查询目标请只填写域名。"
        if port:
            return "", "请移除端口号，只输入域名，例如 example.com。"
        wildcard = value.startswith("*.") or value.startswith("http://*.") or value.startswith("https://*.")
        if wildcard:
            host = "*." + host.lstrip("*.")
        try:
            host.encode("idna")
        except UnicodeError:
            return "", "域名中包含无效字符，请检查后重试。"
        if any(not label or len(label) > 63 or label.startswith("-") or label.endswith("-") for label in host.lstrip("*.").split(".")):
            return "", "域名格式无效，请检查各级域名标签。"
        return host.lower(), None

    def _prepare_cc_query(self, query_id: int, domain: str, params: dict):
        try:
            index_ids = self.client.get_indexes_for_period(**params)
        except APIError as error:
            self.after(0, lambda q=query_id, e=str(error): self._on_cc_prepare_error(q, e))
            return
        except Exception as error:
            self.after(0, lambda q=query_id, e=str(error): self._on_cc_prepare_error(q, e))
            return
        self.after(0, lambda q=query_id, d=domain, ids=index_ids: self._on_cc_indexes_ready(q, d, ids))

    def _on_cc_prepare_error(self, query_id: int, error: str):
        if query_id != self._active_query_id:
            return
        self._query_done()
        if self._stop_event.is_set():
            self.lbl_status.configure(text="已停止索引准备。", text_color=COLORS["muted"])
            self.lbl_cc_indexes.configure(text="可以重新开始查询。")
            self.cc_table.set_empty_message("查询已停止；尚未取得结果")
        else:
            self.lbl_status.configure(text=f"获取索引失败：{error[:120]}", text_color=COLORS["danger"])
            self.lbl_cc_indexes.configure(text="索引列表获取失败；检查网络或代理后可重试。")
            self.cc_table.set_empty_message("获取索引失败；检查网络或代理后可重试")

    def _on_cc_indexes_ready(self, query_id: int, domain: str, index_ids: list[str]):
        if query_id != self._active_query_id:
            return
        if self._stop_event.is_set():
            self._query_done()
            self.lbl_status.configure(text="已停止索引准备。", text_color=COLORS["muted"])
            self.cc_table.set_empty_message("查询已停止；尚未取得结果")
            return
        if not index_ids:
            self._query_done()
            self.lbl_status.configure(text="所选时间范围内没有可用索引。", text_color=COLORS["muted"])
            self.lbl_cc_indexes.configure(text="调整时间范围后可重新查询。")
            self.cc_table.set_empty_message("所选时间范围内没有可用 Common Crawl 索引")
            return
        self.cc_index_ids = index_ids
        self.lbl_cc_indexes.configure(text=f"查询范围：{len(index_ids)} 个索引；每个索引最多 5 页（每页最多 5 个压缩索引块）。")
        self._load_cc_page(domain)

    def _load_cc_page(self, domain: str | None = None):
        """加载 Common Crawl 当前索引"""
        if self.cc_querying:
            return
        if self._stop_event.is_set():
            self.lbl_status.configure(
                text=f"Common Crawl 已停止 (已获取 {len(self.cc_table.all_results)} 条)", text_color="#e65100"
            )
            self._query_done()
            return

        if self.cc_current_page >= len(self.cc_index_ids):
            self.lbl_status.configure(
                text=f"Common Crawl 全部完成: {len(self.cc_table.all_results)} 条", text_color="green"
            )
            self.progress.stop()
            self.progress.set(0)
            self._query_done()
            return

        idx_id = self.cc_index_ids[self.cc_current_page]
        self.cc_querying = True
        self.lbl_status.configure(
            text=f"查询 Common Crawl [{idx_id}]...", text_color="#1565c0"
        )
        self.progress.configure(mode="indeterminate")
        self.progress.start()

        if domain is None:
            domain, error = self._normalize_domain(self.entry_domain.get())
            if error:
                self._on_query_error(error)
                return

        thread = threading.Thread(
            target=self._do_cc_page_query, args=(idx_id, domain, self._active_query_id), daemon=True
        )
        thread.start()

    def _do_cc_page_query(self, idx_id: str, domain: str, query_id: int):
        """后台查询单个 Common Crawl 索引"""
        try:
            if self.cc_current_page > 0 and self._stop_event.wait(1.0):
                self.after(0, lambda i=idx_id, q=query_id: self._on_cc_page_done(i, [], q, 0, 0))
                return
            total_pages = self.client.get_commoncrawl_page_count(
                idx_id, domain, page_size=self.cc_page_size,
            )
            pages_to_fetch = min(total_pages, 5)
            self.after(0, lambda i=idx_id, q=query_id, total=total_pages: self._on_cc_page_count(i, total, q))
            all_from_idx = []
            pages_completed = 0
            for page_num in range(pages_to_fetch):
                if self._stop_event.is_set():
                    break
                if self._stop_event.wait(1.0):
                    break
                try:
                    result = self.client.query_commoncrawl(
                        index_id=idx_id, domain=domain,
                        page=page_num, page_size=self.cc_page_size,
                        total_pages=total_pages,
                    )
                except APIError as error:
                    self.after(0, lambda i=idx_id, q=query_id, msg=str(error), rows=all_from_idx: self._on_cc_page_error(i, msg, q, rows))
                    return
                if not result["results"]:
                    pages_completed += 1
                    break
                all_from_idx.extend(result["results"])
                pages_completed += 1
                if not result["has_more"]:
                    break

            self.after(0, lambda i=idx_id, rows=all_from_idx, q=query_id, total=total_pages, fetched=pages_completed: self._on_cc_page_done(i, rows, q, total, fetched))
        except Exception as e:
            self.after(0, lambda i=idx_id, q=query_id, msg=str(e): self._on_cc_page_error(i, msg, q))

    def _on_cc_page_count(self, idx_id: str, total_pages: int, query_id: int):
        if query_id != self._active_query_id:
            return
        self.lbl_status.configure(
            text=f"Common Crawl [{idx_id}]：索引共 {total_pages} 页，将读取前 {min(total_pages, 5)} 页。",
            text_color=COLORS["primary"],
        )

    def _on_cc_page_done(
        self,
        idx_id: str,
        results: list,
        query_id: int | None = None,
        total_pages: int = 0,
        pages_fetched: int = 0,
    ):
        """单个索引查询完成"""
        if query_id is not None and query_id != self._active_query_id:
            return
        self.cc_querying = False
        self.progress.stop()
        self.progress.set(0)
        self.cc_current_page += 1
        self.cc_table.append_results(results)
        total = len(self.cc_table.all_results)
        if self._stop_event.is_set():
            self.lbl_status.configure(text=f"Common Crawl 已停止：保留 {total} 条已获取结果。", text_color=COLORS["muted"])
            if total == 0:
                self.cc_table.set_empty_message("查询已停止；尚未取得结果")
            self._query_done()
            return
        self.cc_succeeded_indexes.append(idx_id)
        if pages_fetched < total_pages and not self._stop_event.is_set():
            self.cc_truncated_indexes.append(idx_id)
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
            self._query_done()
        else:
            if self.cc_failed_indexes or self.cc_truncated_indexes:
                reasons = []
                if self.cc_failed_indexes:
                    reasons.append(f"{len(self.cc_failed_indexes)} 个失败")
                if self.cc_truncated_indexes:
                    reasons.append(f"{len(self.cc_truncated_indexes)} 个达到 5 页上限")
                self.lbl_status.configure(text=f"Common Crawl 部分完成：{total} 条；" + "，".join(reasons), text_color="#B7791F")
                details = []
                if self.cc_failed_indexes:
                    details.append("失败索引：" + ", ".join(i for i, _ in self.cc_failed_indexes))
                if self.cc_truncated_indexes:
                    details.append("达到页数上限：" + ", ".join(self.cc_truncated_indexes))
                self.lbl_cc_indexes.configure(text="；".join(details))
            else:
                self.lbl_status.configure(text=f"Common Crawl 完成：{total} 条，处理 {len(self.cc_succeeded_indexes)} 个索引", text_color=COLORS["success"])
            if total == 0:
                self.cc_table.set_empty_message("查询完成，没有找到存档记录")
            self._query_done()

    def _on_cc_page_error(self, idx_id: str, error_msg: str, query_id: int | None = None, partial_results: list | None = None):
        """单个索引查询出错"""
        if query_id is not None and query_id != self._active_query_id:
            return
        self.cc_querying = False
        self.progress.stop()
        self.progress.set(0)
        self.cc_current_page += 1
        self.cc_failed_indexes.append((idx_id, error_msg))
        if partial_results:
            self.cc_table.append_results(partial_results)
        total = len(self.cc_table.all_results)
        self.lbl_status.configure(
            text=f"索引 {idx_id} 失败，继续后续索引；已记录 {len(self.cc_failed_indexes)} 项失败。", text_color=COLORS["danger"]
        )
        if not self._stop_event.is_set() and self.cc_current_page < len(self.cc_index_ids):
            self._load_cc_page()
        else:
            self.lbl_cc_indexes.configure(text="失败索引：" + ", ".join(i for i, _ in self.cc_failed_indexes))
            if self._stop_event.is_set():
                self.lbl_status.configure(text=f"Common Crawl 已停止：保留 {total} 条结果，{len(self.cc_failed_indexes)} 个索引失败。", text_color=COLORS["muted"])
            elif total:
                self.lbl_status.configure(text=f"Common Crawl 部分完成：{total} 条；{len(self.cc_failed_indexes)} 个索引失败。", text_color="#B7791F")
                self.cc_table.set_empty_message("有部分索引失败，保留的记录仍可查看和导出")
            else:
                self.lbl_status.configure(text=f"Common Crawl 查询失败：{len(self.cc_failed_indexes)} 个索引失败。", text_color=COLORS["danger"])
                self.cc_table.set_empty_message("查询失败；检查网络或代理后可重试")
            self._query_done()

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
