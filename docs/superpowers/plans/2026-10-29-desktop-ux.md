# Archive Recon 桌面体验重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重组 Archive Recon 桌面查询流程，让来源选择、长任务进度、失败索引、筛选和导出范围都清楚易用，同时保留现有数据能力。

**Architecture:** 保留 Python、CustomTkinter、ttk Treeview 与 requests。将查询生命周期和结果状态明确化，再重构来源配置/任务概览/结果工作区；网络调用在后台线程执行，所有控件更新由 Tk 主线程处理。优先在 `main.py` 内形成清楚边界，不做无关拆文件。

**Tech Stack:** Python 3.10+、CustomTkinter 6.0+、ttk、requests。

**Spec:** `docs/superpowers/specs/2026-10-29-desktop-ux-design.md`

## Global Constraints

- 沿用 Python、CustomTkinter、ttk Treeview 和 requests；尽可能复用现有筛选/导出行为。
- UI 更新必须留在 Tk 主线程；后台网络操作不得直接触碰 Tk 控件。
- 查询取消、部分结果保留、索引列表获取和失败索引记录须由单一明确的任务状态模型驱动，避免界面状态与线程状态各自漂移。
- 保留浅色/深色系统外观适配和常见桌面尺寸支持；新界面不能依赖超宽窗口才能操作。
- 不能把“代理已应用”表述为已验证网络连通。
- 不增加并发请求或改变服务端访问节奏；不引入 Go 或新依赖。

## Review Focus

- 输入含协议、路径、端口、空白或非法格式：目标规范化和校验结果明确，错误不启动后台任务。
- Common Crawl 索引列表请求超时/失败或用户停止：窗口保持响应，任务进入失败或停止状态。
- 单个或连续索引请求失败：失败项及原因保留，部分成功结果仍可用。
- 筛选清空/切换、敏感路径快速过滤与分页联动：记录总量和筛选量一致，空状态不会伪装成无查询结果。
- 导出在筛选为空或存在多页时：文件内容严格对应当前筛选后的全部结果，而非当前页。

---

### Task 1: 建立来源任务状态与后台查询生命周期

**Files:**
- Modify: `main.py::ArchiveSearchApp` 查询状态初始化、`_start_wayback_query`、`_do_wayback_query`、`_start_cc_query`、`_load_cc_page`、`_do_cc_page_query`、完成/错误/停止回调
- Modify: `api_client.py::ArchiveAPIClient` 仅在任务回调需要额外元数据时调整返回结构

**Interfaces:**
- 建立单来源 `QueryJob` 数据对象：`source: str`、`status: str`、`total: int`、`current_item: str`、`completed_items: list[str]`、`failed_items: list[dict[str, str]]`、`started_at: float | None`。
- `ArchiveSearchApp` 维护按来源索引的任务；状态限定为 `idle | preparing | running | stopping | completed | partial | failed | stopped`。
- Worker 通过主线程调度回传不可变事件数据，不直接配置 Tk 控件。

- [ ] 将 Common Crawl 索引发现移入 worker；主线程只接收开始、进度、结果、失败和结束事件。
- [ ] 通过 `ArchiveAPIClient.get_commoncrawl_page_count(index_id, domain, page_size=5, filters=None)` 使用 `showNumPages=true` 读取服务端页数；`pageSize` 明确按压缩索引块理解，不能按 URL 行数估算。
- [ ] 对单索引失败保留索引 ID 和简短原因，不把失败的截断记为成功；继续策略保持逐索引顺序。
- [ ] 每个索引最多读取前 5 页，页间等待 1 秒；页数超限要在结果状态中明确报告截断索引。
- [ ] Wayback 保留 20 页 × 50 条上限，在任务状态和完成文案中标出上限及“可能为部分结果”。
- [ ] 停止任务后保留已收集结果，记录 stopped/partial 状态；避免旧 worker 事件污染新任务。
- [ ] 明确目标输入规范化与校验：接受域名及可选 `*.` 前缀，清理协议和末尾 `/`；对路径、端口、空白和非法值提示原因。
- [ ] 确认线程/事件状态所有转换都对应设计中的完成、部分完成、失败、停止、无结果等情况。

### Task 2: 重构目标、来源和网络设置入口

**Files:**
- Modify: `main.py::ArchiveSearchApp._build_ui`
- Modify: `main.py::ArchiveSearchApp._build_cc_panel`
- Modify: `main.py::CCTimeSelector`
- Modify: `main.py::ArchiveSearchApp._apply_proxy`

**Interfaces:**
- 一个目标输入和校验反馈区。
- 两个独立来源操作入口，来源配置清楚展示；Common Crawl 时间选项仅在该来源区域展示。
- 可展开的网络设置区保留代理输入和应用状态；如代理地址包含凭据，显示状态时隐藏凭据部分。

- [ ] 将目标输入作为第一视觉层级，并就近说明 `example.com`、`*.example.com` 等接受格式。
- [ ] 为 Wayback 与 Common Crawl 说明各自覆盖方式和结果限制；Common Crawl 时间范围与该来源选择相邻。
- [ ] 将代理移入可展开设置，保留 `http://127.0.0.1:7890` 默认值；区分“已应用”与连通性状态。
- [ ] 让来源任务可分别启动/停止；首轮不并发运行两个来源，避免共享取消状态的歧义。
- [ ] 确保原有系统浅色/深色外观及小窗口布局可用。

### Task 3: 构建统一任务进度与恢复反馈

**Files:**
- Modify: `main.py::ArchiveSearchApp` 任务事件回调和状态区域
- Modify: `main.py::ArchiveSearchApp._build_ui`

**Interfaces:**
- 任务概览按来源展示 `status`、`current_item`、`total`、开始时间/耗时、已完成数量、待处理数量、失败数量和操作按钮。
- 事件回调按来源与任务标识校验，过期任务事件忽略。

- [ ] 展示 Common Crawl 索引总数、当前索引及待处理/成功/失败数量；索引列表下载阶段显示为准备中。
- [ ] 在任务行显示当前状态、已收记录、当前页/索引与可停止操作；忙碌期间按钮状态一致。
- [ ] 停止、部分完成、失败、无匹配索引和成功分别提供清楚反馈及下一步操作。
- [ ] 已有部分结果时保留结果表格并显示部分状态；失败索引列表可查看。
- [ ] 确认代理应用和查询错误反馈不使用阻断弹窗作为唯一信息出口。

### Task 4: 整理结果工作区、筛选和导出提示

**Files:**
- Modify: `main.py::ResultsTable._build_ui`
- Modify: `main.py::ResultsTable.set_results`、`append_results`、`_apply_filters`、`_clear_filters`、`_refresh_view`、`_export_csv`、`_export_json`
- Modify: `main.py::ArchiveSearchApp` 结果区布局

**Interfaces:**
- 结果摘要提供总数、当前筛选数、来源与范围说明。
- 基础筛选：URL 关键词、状态码、文件类型。
- 高级筛选：域名及现有逗号多值/`!` 排除语义。
- 敏感路径快速过滤状态只表示现有路径模式命中。

- [ ] 将摘要置于表格上方，筛选变化时同步更新总记录与匹配记录数量。
- [ ] 常用筛选默认可见，域名和排除语法放入可展开高级筛选；原语义保持一致。
- [ ] 增加敏感路径快速筛选，复用 `is_interesting_url`；明确说明按路径模式标记。
- [ ] 为空结果、筛选无匹配、加载中、停止后的部分结果分别提供独立状态说明。
- [ ] 标明 CSV/JSON 导出包含当前筛选后的全部记录；保持排序、分页、复制、字号和列布局功能。
- [ ] 在浅色/深色主题和常见窗口宽度下复核控件可见性及表格操作。

### Task 5: 更新使用说明与交付核对

**Files:**
- Modify: `README.md`
- Review: `main.py`、`api_client.py`、`启动工具.bat`

- [ ] 更新安装/启动说明、Tkinter 运行时要求和新查询流程。
- [ ] 说明结果上限、索引失败、取消后部分结果及敏感路径命中含义。
- [ ] 按用户授权执行验证；核对启动器预检、输入边界、两数据源状态分支、筛选/分页/导出范围及浅/深主题。
- [ ] 汇报实现文件和具体代码路径，并说明验证证据与未覆盖范围。

## 体验验收（用户要求）

- 在 Windows 桌面实际启动应用并检查浅色/深色主题和常见窗口尺寸下的可读性。
- 用无网络副作用的本地假数据体验首次查询引导、输入错误、任务进度/停止、部分失败、常用与高级筛选、敏感路径标记、分页及导出范围。
- 对实际数据源流程只在 UI 交互中确认状态与错误反馈；不得为体验测试访问未指定的目标域名。
- 按体验发现的问题修整后再重复完整路径；不能以代码静态检查代替该验收。

## 本轮体验验收记录

- Windows 11 桌面上以 Python 3.13 + Tkinter/CustomTkinter 启动并目视检查主窗口、网络设置折叠、高级筛选展开、空结果提示、目标输入错误提示、Common Crawl 进度及结果表。
- 本地假数据包含 4 条记录和 3 个索引，其中 1 个索引失败；界面最终显示 4 条记录、1 个索引失败，并保留失败索引名称。
- 启用敏感路径模式后界面筛为 2/4 条；导出的 CSV 实际核对为 2 行，内容仅包含匹配的 `.env` 与 `/admin` 记录。
- 未对外部目标域名发起体验查询。浅色主题完成目视检查；深色主题与更小窗口尺寸未在本轮桌面体验中逐一检查。
- 桌面体验曾在文件保存对话框环节被用户按键中断；随后用户明确要求继续。通过本地自动保存体验流程完成 CSV 内容核对。
- 额外验证：`python -m unittest discover -s tests -v` 为 6 项通过；`py_compile main.py api_client.py` 通过；`git diff --check` 无错误。
