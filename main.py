"""
渗透测试辅助工具 - 网页存档信息搜集
GUI 主程序
"""

import threading
from urllib.parse import urlsplit
import os
import sys
from datetime import datetime
from tkinter import filedialog, messagebox
import tkinter as tk
from tkinter import ttk

import customtkinter as ctk

from api_client import ArchiveAPIClient, APIError
from archrecon import (
    AppError,
    FilterSpec,
    JobCoordinator,
    JobStatus,
    ResultCollection,
    extract_hostname,
    is_interesting_url,
    match_domain_pattern,
    match_domain_patterns,
    write_csv,
    write_json,
)


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
            font_obj = tkfont.Font(family=FONT_FAMILY, size=12)
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
# 字体按平台选择，缺失时由 Tk 自动回退到系统默认字体
FONT_FAMILY = {
    "win32": "Microsoft YaHei UI",
    "darwin": "PingFang SC",
}.get(sys.platform, "Noto Sans CJK SC")


def _default_proxy_from_env() -> str:
    """读取系统代理环境变量作为默认代理，未设置时留空（直连）"""
    for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        value = (os.environ.get(key) or "").strip()
        if value:
            return value
    return ""

# 敏感/有趣的文件扩展名与路径规则集中在 archrecon.matching，界面直接复用。


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
        self.collection = ResultCollection(source_name=source_name)
        self.page_size = 50
        self.current_page = 0
        self.sort_column = None
        self.sort_reverse = False
        self.current_font_size = 11
        self.empty_message = "输入目标域名并开始查询\n结果会显示在这里"

        self._build_ui()

    # ---- 只读兼容视图：原始集合与当前筛选视图 ----
    @property
    def all_results(self) -> list:
        return list(self.collection.records)

    @property
    def filtered_results(self) -> list:
        return list(self.collection.view)

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
        """替换全部结果并显示第一页（同批重复 URL 只保留首条）"""
        self.collection.reset(results)
        self.current_page = 0
        self._update_domain_dropdown()
        self._refresh_view()

    def set_empty_message(self, message: str):
        self.empty_message = message
        if not self.collection.view:
            self.empty_state.configure(text=message)
            self.empty_state.place(relx=0.5, rely=0.47, anchor="center")

    def append_results(self, results: list):
        """追加结果（懒加载）。

        同批与跨批重复的 URL 只保留首条；追加后重新应用当前筛选与排序，
        原始集合的记录顺序保持不变。返回本次追加统计。
        """
        outcome = self.collection.append(results)
        self._update_domain_dropdown()
        self._clamp_page()
        self._refresh_view()
        return outcome

    # ==================== 筛选 ====================

    def _apply_filters(self):
        """应用筛选条件（支持排除：以 ! 开头表示排除该项）"""
        spec = FilterSpec(
            status=self.filter_status.get().strip(),
            file_type=self.filter_mime.get().strip(),
            url_keyword=self.filter_url.get().strip(),
            domain=self.filter_domain.get().strip(),
            interesting_only=bool(self.interesting_only.get()),
        )
        self.collection.apply_filter(spec)
        self.current_page = 0
        self._refresh_view()

    def _clear_filters(self):
        """清除筛选条件"""
        self.filter_status.set("")
        self.filter_mime.set("")
        self.filter_url.delete(0, "end")
        self.filter_domain.set("")
        self.interesting_only.set(False)
        self.collection.clear_filter()
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
        """从当前全量结果中提取域名并统计数量，更新下拉框。保留当前输入值。"""
        from collections import Counter
        hostnames = []
        for record in self.collection.records:
            hn = extract_hostname(record.url)
            if hn:
                hostnames.append(hn)
        counter = Counter(hostnames)
        # 按数量降序排列，格式 "hostname (count)"，空值始终在第一项
        values = [""] + [f"{hn} ({cnt})" for hn, cnt in counter.most_common()]
        self.filter_domain.configure(values=values)
        # 不覆盖用户当前输入：下拉列表变化时保持筛选条件与控件文本一致

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
            total_pages = self.collection.page_count(self.page_size)
            if page < 0:
                page = 0
            if page >= total_pages:
                page = total_pages - 1
            self.current_page = page
            self._refresh_view()
        except ValueError:
            pass

    def _clamp_page(self):
        """追加或筛选后确保当前页码仍合法。"""
        total_pages = self.collection.page_count(self.page_size)
        if self.current_page >= total_pages:
            self.current_page = total_pages - 1
        if self.current_page < 0:
            self.current_page = 0

    # ---- 域名工具方法（保留原有调用签名，实现位于 archrecon.matching） ----
    _extract_hostname = staticmethod(extract_hostname)
    _match_domain_pattern = staticmethod(match_domain_pattern)

    @classmethod
    def _match_domain_patterns(cls, url: str, include_patterns: list, exclude_patterns: list) -> bool:
        """组合 include / exclude 域名模式匹配；exclude 优先。"""
        return match_domain_patterns(url, include_patterns, exclude_patterns)

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
        font = tkfont.Font(family=FONT_FAMILY, size=self.current_font_size)

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
        """按列排序（只改变派生视图，不修改原始集合）"""
        if column == "#":
            return  # 序号列不可排序

        if self.sort_column == column:
            self.sort_reverse = not self.sort_reverse
        else:
            self.sort_column = column
            self.sort_reverse = False

        self.collection.set_sort(self.sort_column, self.sort_reverse)
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
        total_pages = self.collection.page_count(self.page_size)
        if self.current_page < total_pages - 1:
            self.current_page += 1
            self._refresh_view()

    def _refresh_view(self):
        """刷新表格显示（数据来自结果集合的筛选视图）"""
        # 清空
        for item in self.tree.get_children():
            self.tree.delete(item)

        self._clamp_page()
        start = self.current_page * self.page_size
        page_data = self.collection.page(self.current_page, self.page_size)
        if page_data:
            self.empty_state.place_forget()
        else:
            if self.collection.total_count:
                empty_text = "没有符合条件的结果\n清除筛选或调整关键词后重试"
            else:
                empty_text = self.empty_message
            self.empty_state.configure(text=empty_text)
            self.empty_state.place(relx=0.5, rely=0.47, anchor="center")

        # 数据列 key（去掉 # 列）
        data_keys = [c[0] for c in self.COLUMNS if c[0] != "#"]

        for i, record in enumerate(page_data):
            row_num = start + i + 1  # 全局行号
            values = [row_num] + [record.value_of(k) for k in data_keys]
            tags = ()
            if is_interesting_url(record.url):
                tags = ("interesting",)
            self.tree.insert("", "end", values=values, tags=tags)

        total = self.collection.view_count
        total_records = self.collection.total_count
        total_pages = self.collection.page_count(self.page_size)

        if total == total_records:
            self.lbl_stats.configure(text=f"共 {total:,} 条结果")
        else:
            self.lbl_stats.configure(text=f"匹配 {total:,} / 共 {total_records:,} 条")
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

    def _export_snapshot(self) -> list[dict]:
        """导出快照：当前筛选与排序下的全部记录，不受分页影响。"""
        return self.collection.snapshot()

    def _export_csv(self):
        filepath = filedialog.asksaveasfilename(
            defaultextension=".csv",
            filetypes=[("CSV 文件", "*.csv")],
            initialfile=f"{self.source_name}_results.csv",
        )
        if not filepath:
            return

        try:
            count = write_csv(self._export_snapshot(), filepath)
            messagebox.showinfo("导出成功", f"已导出 {count} 条记录到:\n{filepath}")
        except AppError as error:
            messagebox.showerror("导出失败", str(error))
        except Exception as error:
            messagebox.showerror("导出失败", str(error))

    def _export_json(self):
        filepath = filedialog.asksaveasfilename(
            defaultextension=".json",
            filetypes=[("JSON 文件", "*.json")],
            initialfile=f"{self.source_name}_results.json",
        )
        if not filepath:
            return

        try:
            count = write_json(self._export_snapshot(), filepath)
            messagebox.showinfo("导出成功", f"已导出 {count} 条记录到:\n{filepath}")
        except AppError as error:
            messagebox.showerror("导出失败", str(error))
        except Exception as error:
            messagebox.showerror("导出失败", str(error))


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

        # 查询控制：一次查询一个任务，job_id 用于丢弃旧任务的迟到事件
        self.jobs = JobCoordinator()
        self._current_job = None
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
        self.entry_proxy.insert(0, _default_proxy_from_env())
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

    def _query_starting(self, source: str):
        """进入查询状态并创建新任务；未结束的旧任务会被标记为已停止。"""
        job = self.jobs.start(source)
        self._current_job = job
        self._stop_event = job.stop_event
        self.btn_wb_query.configure(state="disabled")
        self.btn_cc_query.configure(state="disabled")
        self.btn_stop.pack(side="right", padx=5)  # 显示停止按钮
        self.btn_stop.configure(state="normal", text="停止")
        return job

    def _query_done(self, job_id: int | None = None) -> bool:
        """退出查询状态；旧任务的迟到回调直接忽略。"""
        if job_id is not None and not self.jobs.accepts(job_id):
            return False
        self.btn_stop.pack_forget()  # 隐藏停止按钮
        self.btn_stop.configure(state="normal", text="停止")
        self.btn_wb_query.configure(state="normal")
        self.btn_cc_query.configure(state="normal")
        self.progress.stop()
        self.progress.configure(mode="determinate")
        self.progress.set(0)
        return True

    def _finish_job(self, job_id: int, status: JobStatus, reason: str = "") -> None:
        """把当前任务落到终态；旧任务或已结束任务不重复处理。"""
        job = self.jobs.get(job_id)
        if job is None or job.is_terminal:
            return
        job.finish(status, reason)

    def _stop_query(self):
        """停止当前查询：立即反馈，取消在途请求按超时收敛。"""
        job = self.jobs.active_job
        if job is not None:
            job.request_stop()
        else:
            self._stop_event.set()
        self.lbl_status.configure(text="正在停止...（等待当前请求返回）", text_color="#e65100")
        self.btn_stop.configure(state="disabled", text="停止中...")

    # ==================== 查询 Wayback Machine ====================

    def _start_wayback_query(self):
        """开始 Wayback Machine 查询"""
        domain = self.entry_domain.get().strip()
        domain, error = self._normalize_domain(domain)
        if error:
            self.lbl_status.configure(text=error, text_color=COLORS["danger"])
            return

        job = self._query_starting("wayback")
        self.wayback_table.set_results([])  # 清空旧结果
        self.wayback_table.set_empty_message("正在读取 Wayback 存档…")
        self.tabview.set("Wayback Machine")
        self.lbl_status.configure(text="Wayback Machine：每次最多读取 20 页（约 1,000 条）；更多存档可能未显示。", text_color=COLORS["primary"])

        self._query_thread = threading.Thread(
            target=self._do_wayback_query,
            args=(job.job_id, domain, job.stop_event),
            daemon=True,
        )
        self._query_thread.start()

    def _do_wayback_query(self, job_id: int, domain: str, stop_event):
        """后台线程：逐页查询并实时推送结果（事件带 job_id，旧任务事件会被丢弃）"""
        import time as _time
        total = 0
        reached_limit_with_more = False
        client = self.client

        try:
            for page in range(20):  # 最多 20 页（每页 50 条 = 最多 1000 条）
                if stop_event.is_set():
                    self.after(0, lambda: self._on_wayback_stopped(job_id))
                    return

                try:
                    result = client.query_wayback(
                        domain=domain, page=page, page_size=50, match_type="domain"
                    )
                except APIError as error:
                    self.after(0, lambda msg=str(error): self._on_wayback_error(job_id, msg, total))
                    return

                batch = result.get("results", [])
                if not batch:
                    break
                if page == 19 and result.get("has_more", False):
                    reached_limit_with_more = True

                # 实时推送到主线程
                self.after(0, lambda b=batch, p=page: self._on_wayback_batch(job_id, b, p))
                total += len(batch)

                if not result.get("has_more", False):
                    break

                # 页间短暂延迟，避免触发服务端限流
                if not stop_event.is_set():
                    _time.sleep(0.4)

            if not stop_event.is_set():
                self.after(0, lambda: self._on_wayback_done(job_id, reached_limit_with_more))

        except Exception as error:
            self.after(0, lambda msg=str(error): self._on_wayback_error(job_id, msg, total))

    def _on_wayback_batch(self, job_id: int, batch: list, page: int):
        """收到一页结果，即时追加到表格（只接受当前任务的数据）"""
        if not self.jobs.accepts_data(job_id):
            return
        job = self.jobs.get(job_id)
        outcome = self.wayback_table.append_results(batch)
        job.note_batch(len(batch), outcome.total)
        self.lbl_status.configure(
            text=f"Wayback Machine: 已获取 {outcome.total} 条 (第 {page + 1} 页)", text_color="#1565c0"
        )

    def _on_wayback_stopped(self, job_id: int):
        """Wayback 已停止：保留已收结果并允许导出。"""
        if not self.jobs.accepts(job_id):
            return
        job = self.jobs.get(job_id)
        job.completeness = "partial"
        self._finish_job(job_id, JobStatus.STOPPED, "用户停止")
        total = self.wayback_table.collection.total_count
        if total == 0:
            self.wayback_table.set_empty_message("查询已停止；尚未取得结果")
        self.lbl_status.configure(
            text=f"Wayback Machine 已停止 (已获取 {total} 条)", text_color="#e65100"
        )
        self._query_done()

    def _on_wayback_error(self, job_id: int, error_msg: str, total: int):
        """Wayback 请求失败：停止时按已停止处理，否则保留部分结果或提示失败。"""
        if not self.jobs.accepts(job_id):
            return
        job = self.jobs.get(job_id)
        if job.stop_event.is_set():
            self._on_wayback_stopped(job_id)
            return
        if total > 0 or self.wayback_table.collection.total_count > 0:
            job.completeness = "partial"
            self._finish_job(job_id, JobStatus.PARTIAL, error_msg[:200])
            held = self.wayback_table.collection.total_count
            self.lbl_status.configure(
                text=f"Wayback Machine 中断 (已获取 {held} 条)：{error_msg[:80]}",
                text_color="#e65100",
            )
            self._query_done()
            return
        self._finish_job(job_id, JobStatus.FAILED, error_msg[:200])
        self._on_query_error(error_msg)
        self._query_done()

    def _on_wayback_done(self, job_id: int, reached_limit_with_more: bool = False):
        """Wayback 查询完成"""
        if not self.jobs.accepts(job_id):
            return
        job = self.jobs.get(job_id)
        total = self.wayback_table.collection.total_count
        self.wayback_table.current_page = 0
        self.wayback_table._refresh_view()
        if total == 0:
            self._finish_job(job_id, JobStatus.COMPLETED)
            self._query_done()
            self.lbl_status.configure(text="Wayback Machine 完成：0 条结果", text_color=COLORS["success"])
            self.wayback_table.set_empty_message("查询完成，没有找到存档记录")
            return
        if reached_limit_with_more:
            job.completeness = "partial"
            self._finish_job(job_id, JobStatus.PARTIAL, "已读满 20 页上限")
            self._query_done()
            self.lbl_status.configure(
                text=f"Wayback Machine 部分完成：已读满 20 页 / {total} 条，可能仍有更多存档。",
                text_color="#B7791F",
            )
        else:
            self._finish_job(job_id, JobStatus.COMPLETED)
            self._query_done()
            self.lbl_status.configure(
                text=f"Wayback Machine 完成: {total} 条结果", text_color=COLORS["success"]
            )

    def _on_query_error(self, error_msg: str):
        """查询出错提示（不改变查询状态，由调用方收尾）"""
        self.lbl_status.configure(text="查询失败", text_color=COLORS["danger"])
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

        job = self._query_starting("commoncrawl")
        self.cc_index_ids = []
        self.cc_current_page = 0
        self.cc_querying = False
        self.cc_failed_indexes = []
        self.cc_succeeded_indexes = []
        self.cc_truncated_indexes = []
        self.cc_table.set_results([])
        self.cc_table.set_empty_message("正在获取 Common Crawl 索引列表…")
        self.tabview.set("Common Crawl")
        self.lbl_status.configure(text="正在获取 Common Crawl 索引列表…", text_color=COLORS["primary"])
        self.lbl_cc_indexes.configure(text="正在获取可用索引…")
        params = self.cc_time_selector.get_query_params()
        threading.Thread(
            target=self._prepare_cc_query,
            args=(job.job_id, domain, params, job.stop_event),
            daemon=True,
        ).start()

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

    def _prepare_cc_query(self, job_id: int, domain: str, params: dict, stop_event):
        """后台获取索引列表；失败与停止都带上 job_id。"""
        try:
            index_ids = self.client.get_indexes_for_period(**params)
        except Exception as error:
            self.after(0, lambda e=str(error): self._on_cc_prepare_error(job_id, e))
            return
        if stop_event.is_set():
            self.after(0, lambda: self._on_cc_prepare_error(job_id, "用户停止"))
            return
        self.after(0, lambda ids=index_ids: self._on_cc_indexes_ready(job_id, ids))

    def _on_cc_prepare_error(self, job_id: int, error: str):
        if not self.jobs.accepts(job_id):
            return
        job = self.jobs.get(job_id)
        if job.stop_event.is_set():
            job.completeness = "partial"
            self._finish_job(job_id, JobStatus.STOPPED, "用户停止索引准备")
            self._query_done()
            self.lbl_status.configure(text="已停止索引准备。", text_color=COLORS["muted"])
            self.lbl_cc_indexes.configure(text="可以重新开始查询。")
            self.cc_table.set_empty_message("查询已停止；尚未取得结果")
        else:
            self._finish_job(job_id, JobStatus.FAILED, error[:200])
            self._query_done()
            self.lbl_status.configure(text=f"获取索引失败：{error[:120]}", text_color=COLORS["danger"])
            self.lbl_cc_indexes.configure(text="索引列表获取失败；检查网络或代理后可重试。")
            self.cc_table.set_empty_message("获取索引失败；检查网络或代理后可重试")

    def _on_cc_indexes_ready(self, job_id: int, index_ids: list[str]):
        if not self.jobs.accepts(job_id):
            return
        job = self.jobs.get(job_id)
        if job.stop_event.is_set():
            job.completeness = "partial"
            self._finish_job(job_id, JobStatus.STOPPED, "用户停止索引准备")
            self._query_done()
            self.lbl_status.configure(text="已停止索引准备。", text_color=COLORS["muted"])
            self.cc_table.set_empty_message("查询已停止；尚未取得结果")
            return
        if not index_ids:
            self._finish_job(job_id, JobStatus.COMPLETED, "所选时间范围内没有可用索引")
            self._query_done()
            self.lbl_status.configure(text="所选时间范围内没有可用索引。", text_color=COLORS["muted"])
            self.lbl_cc_indexes.configure(text="调整时间范围后可重新查询。")
            self.cc_table.set_empty_message("所选时间范围内没有可用 Common Crawl 索引")
            return
        self.cc_index_ids = index_ids
        self.lbl_cc_indexes.configure(text=f"查询范围：{len(index_ids)} 个索引；每个索引最多 5 页（每页最多 5 个压缩索引块）。")
        self._load_cc_page(job_id=job_id)

    def _load_cc_page(self, domain: str | None = None, job_id: int | None = None):
        """加载 Common Crawl 当前索引（旧任务不再推进）"""
        if self.cc_querying:
            return
        job = self.jobs.get(job_id) if job_id is not None else self.jobs.active_job
        if job is None or not self.jobs.accepts(job.job_id):
            return

        if job.stop_event.is_set():
            job.completeness = "partial"
            total = self.cc_table.collection.total_count
            self._finish_job(job.job_id, JobStatus.STOPPED, "用户停止")
            self._query_done()
            self.lbl_status.configure(
                text=f"Common Crawl 已停止 (已获取 {total} 条)", text_color="#e65100"
            )
            return

        if self.cc_current_page >= len(self.cc_index_ids):
            total = self.cc_table.collection.total_count
            self._finish_job(job.job_id, JobStatus.COMPLETED)
            self.progress.stop()
            self.progress.set(0)
            self._query_done()
            self.lbl_status.configure(
                text=f"Common Crawl 全部完成: {total} 条", text_color=COLORS["success"]
            )
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
                self.cc_querying = False
                self.progress.stop()
                self.progress.set(0)
                self._finish_job(job.job_id, JobStatus.FAILED, error)
                self._on_query_error(error)
                self._query_done()
                return

        thread = threading.Thread(
            target=self._do_cc_page_query,
            args=(job.job_id, idx_id, domain, job.stop_event),
            daemon=True,
        )
        thread.start()

    def _do_cc_page_query(self, job_id: int, idx_id: str, domain: str, stop_event):
        """后台查询单个 Common Crawl 索引"""
        try:
            if self.cc_current_page > 0 and stop_event.wait(1.0):
                self.after(0, lambda: self._on_cc_page_done(job_id, idx_id, [], 0, 0))
                return
            total_pages = self.client.get_commoncrawl_page_count(
                idx_id, domain, page_size=self.cc_page_size,
            )
            pages_to_fetch = min(total_pages, 5)
            self.after(0, lambda total=total_pages: self._on_cc_page_count(job_id, idx_id, total))
            all_from_idx = []
            pages_completed = 0
            for page_num in range(pages_to_fetch):
                if stop_event.is_set():
                    break
                if stop_event.wait(1.0):
                    break
                try:
                    result = self.client.query_commoncrawl(
                        index_id=idx_id, domain=domain,
                        page=page_num, page_size=self.cc_page_size,
                        total_pages=total_pages,
                    )
                except APIError as error:
                    self.after(
                        0,
                        lambda msg=str(error), rows=list(all_from_idx): self._on_cc_page_error(
                            job_id, idx_id, msg, rows
                        ),
                    )
                    return
                if not result["results"]:
                    pages_completed += 1
                    break
                all_from_idx.extend(result["results"])
                pages_completed += 1
                if not result["has_more"]:
                    break

            self.after(
                0,
                lambda rows=list(all_from_idx), total=total_pages, fetched=pages_completed: self._on_cc_page_done(
                    job_id, idx_id, rows, total, fetched
                ),
            )
        except Exception as error:
            self.after(
                0,
                lambda msg=str(error): self._on_cc_page_error(job_id, idx_id, msg),
            )

    def _on_cc_page_count(self, job_id: int, idx_id: str, total_pages: int):
        if not self.jobs.accepts(job_id):
            return
        self.lbl_status.configure(
            text=f"Common Crawl [{idx_id}]：索引共 {total_pages} 页，将读取前 {min(total_pages, 5)} 页。",
            text_color=COLORS["primary"],
        )

    def _on_cc_page_done(
        self,
        job_id: int,
        idx_id: str,
        results: list,
        total_pages: int = 0,
        pages_fetched: int = 0,
    ):
        """单个索引查询完成（只接受当前任务数据）"""
        if not self.jobs.accepts_data(job_id):
            return
        job = self.jobs.get(job_id)
        self.cc_querying = False
        self.progress.stop()
        self.progress.set(0)
        self.cc_current_page += 1
        outcome = self.cc_table.append_results(results)
        total = outcome.total
        job.note_batch(len(results), total)
        if job.stop_event.is_set():
            job.completeness = "partial"
            self._finish_job(job_id, JobStatus.STOPPED, "用户停止")
            self.lbl_status.configure(
                text=f"Common Crawl 已停止：保留 {total} 条已获取结果。", text_color=COLORS["muted"]
            )
            if total == 0:
                self.cc_table.set_empty_message("查询已停止；尚未取得结果")
            self._query_done()
            return
        self.cc_succeeded_indexes.append(idx_id)
        if pages_fetched < total_pages and not job.stop_event.is_set():
            self.cc_truncated_indexes.append(idx_id)
        self.lbl_status.configure(
            text=f"Common Crawl [{idx_id}]: +{outcome.added} 条 | 总计: {total} 条",
            text_color="green",
        )

        if not job.stop_event.is_set() and self.cc_current_page < len(self.cc_index_ids):
            self._load_cc_page(job_id=job_id)
        elif job.stop_event.is_set():
            job.completeness = "partial"
            self._finish_job(job_id, JobStatus.STOPPED, "用户停止")
            self.lbl_status.configure(
                text=f"Common Crawl 已停止 (已获取 {total} 条)", text_color="#e65100"
            )
            self._query_done()
        else:
            if self.cc_failed_indexes or self.cc_truncated_indexes:
                job.completeness = "partial"
                reasons = []
                if self.cc_failed_indexes:
                    reasons.append(f"{len(self.cc_failed_indexes)} 个失败")
                if self.cc_truncated_indexes:
                    reasons.append(f"{len(self.cc_truncated_indexes)} 个达到 5 页上限")
                self._finish_job(job_id, JobStatus.PARTIAL, "；".join(reasons))
                self.lbl_status.configure(text=f"Common Crawl 部分完成：{total} 条；" + "，".join(reasons), text_color="#B7791F")
                details = []
                if self.cc_failed_indexes:
                    details.append("失败索引：" + ", ".join(i for i, _ in self.cc_failed_indexes))
                if self.cc_truncated_indexes:
                    details.append("达到页数上限：" + ", ".join(self.cc_truncated_indexes))
                self.lbl_cc_indexes.configure(text="；".join(details))
            else:
                self._finish_job(job_id, JobStatus.COMPLETED)
                self.lbl_status.configure(text=f"Common Crawl 完成：{total} 条，处理 {len(self.cc_succeeded_indexes)} 个索引", text_color=COLORS["success"])
            if total == 0:
                self.cc_table.set_empty_message("查询完成，没有找到存档记录")
            self._query_done()

    def _on_cc_page_error(self, job_id: int, idx_id: str, error_msg: str, partial_results: list | None = None):
        """单个索引查询出错（只接受当前任务数据）"""
        if not self.jobs.accepts_data(job_id):
            return
        job = self.jobs.get(job_id)
        self.cc_querying = False
        self.progress.stop()
        self.progress.set(0)
        self.cc_current_page += 1
        self.cc_failed_indexes.append((idx_id, error_msg))
        if partial_results:
            self.cc_table.append_results(partial_results)
        total = self.cc_table.collection.total_count
        job.note_batch(len(partial_results or ()), total)
        self.lbl_status.configure(
            text=f"索引 {idx_id} 失败，继续后续索引；已记录 {len(self.cc_failed_indexes)} 项失败。", text_color=COLORS["danger"]
        )
        if not job.stop_event.is_set() and self.cc_current_page < len(self.cc_index_ids):
            self._load_cc_page(job_id=job_id)
        else:
            self.lbl_cc_indexes.configure(text="失败索引：" + ", ".join(i for i, _ in self.cc_failed_indexes))
            if job.stop_event.is_set():
                job.completeness = "partial"
                self._finish_job(job_id, JobStatus.STOPPED, "用户停止")
                self.lbl_status.configure(text=f"Common Crawl 已停止：保留 {total} 条结果，{len(self.cc_failed_indexes)} 个索引失败。", text_color=COLORS["muted"])
            elif total:
                job.completeness = "partial"
                self._finish_job(job_id, JobStatus.PARTIAL, "部分索引失败")
                self.lbl_status.configure(text=f"Common Crawl 部分完成：{total} 条；{len(self.cc_failed_indexes)} 个索引失败。", text_color="#B7791F")
                self.cc_table.set_empty_message("有部分索引失败，保留的记录仍可查看和导出")
            else:
                self._finish_job(job_id, JobStatus.FAILED, "全部索引失败")
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
                job = self.jobs.active_job
                if (
                    not self.cc_querying
                    and job is not None
                    and not job.stop_event.is_set()
                    and self.cc_current_page < len(self.cc_index_ids)
                ):
                    self._load_cc_page(job_id=job.job_id)
        except (IndexError, Exception):
            pass


# ==================== 入口 ====================
def main():
    app = ArchiveSearchApp()
    app.mainloop()


if __name__ == "__main__":
    main()
