# NEPT-3 独立验收清单（T1–T6）

- 基线：`8e6aaf9fc810d29011c4a61233e22aa7fabcc378`
- 基线验收执行日期：2026-11-13
- 执行平台：Windows 11 Pro 10.0.26300 / Python 3.13.15 / 仅 Windows 实测
- 自动用例：`acceptance/`（67 个测试方法，其中基线 14 个子测试失败）
- 本清单是**重构提交的验收契约**；基线结果只说明“现状哪里不满足”，
  不能据此认定重构通过。

## 状态含义

| 状态 | 含义 |
|---|---|
| PASS | 本轮有实际执行证据，基线行为满足该条（或该条属于已通过的回归护栏） |
| FAIL | 本轮有实际执行证据，基线不满足；重构必须修复，或由需求方书面调整验收 |
| GAP | 基线没有可观测输出/能力，需要新增接口或提示；依据为代码路径或探测 |
| BLOCKED | 需要外部来源契约、人工 GUI 操作或跨平台环境，本轮无法闭证 |
| NOT RUN | 本轮未执行，原因已注明 |
| PARTIAL | 部分子项通过、部分未覆盖 |

## T1 目标与查询范围契约（P0）

| ID | 验收项 | 状态 | 证据/说明 |
|---|---|---|---|
| T1-1 | 合法域名形式规范化（大小写、协议、末尾 `/`、`*.` 前缀） | PASS | `test_t1_domain_contract.DomainNormalizationTests.test_valid_forms_normalize` |
| T1-2 | 空值、路径、查询、片段、端口、非法端口、非法 scheme、非法标签拒绝 | PASS | 同一 `test_invalid_forms_are_rejected_with_reason` 的对应子用例 |
| T1-3 | 含用户信息（`user:pass@host`）的输入必须拒绝 | FAIL | 基线返回 `example.com` 并启动查询；4 个子用例失败 |
| T1-4 | 域名内部空白必须拒绝 | FAIL | `exa mple.com`、`example .com` 被接受；4 个子用例失败 |
| T1-5 | 非法输入不进入查询状态、不创建线程、网络调用为 0 | FAIL（仅 T1-3/4）；其余 PASS | `NoRequestOnInvalidInputTests`：对两来源逐个非法输入断言 `Thread` 未被调用、client 无调用 |
| T1-6 | 根域与 `*.根域` 在两来源上表达同一查询范围 | PASS | 两来源 plain/wildcard 请求 query string 完全一致；Wayback `url=example.com&matchType=domain`，CC `url=*.example.com` |
| T1-7 | 来源端匹配语义核实：`matchType=domain` 是否含子域；CC `*.` 是否含裸域 | BLOCKED | 本轮禁止访问外部目标，仓库无离线权威契约；不得凭假设宣称覆盖完整。需要官方文档或经批准的录制响应 |
| T1-8 | 结果域名筛选回归（根域含子域、`badexample.com` 不误匹配、排除优先） | PASS | `ResultDomainFilterTests` |

## T2 完整查询生命周期（P0）

| ID | 验收项 | 状态 | 证据/说明 |
|---|---|---|---|
| T2-1 | 两来源成功路径与零结果（夹具驱动） | PASS | `WaybackParsingTests`、`CommonCrawlParsingTests` |
| T2-2 | Wayback 分页循环直到 `has_more=false`；第 20 页仍有更多时标记部分完成 | PASS | `test_wayback_query_continues_until_has_more_is_false`、`test_wayback_twentieth_page_with_more_is_marked_partial` |
| T2-3 | 超时/429/重试有界，失败给出 `APIError` | PASS | 2 次尝试后失败；429 一次后成功（`time.sleep` 已替换） |
| T2-4 | 停止后不再安排后续页、保留已收记录、显示已停止 | PASS（Wayback 自动）；CC 停止路径未自动覆盖 | `test_stop_prevents_further_wayback_pages`；CC 需 GUI 手工 |
| T2-5 | 停止后立即重启，旧任务事件不串入新结果 | FAIL | Wayback `_on_wayback_batch` 无任务序号/事件归属（`main.py:1390`），新任务清空 `_stop_event` 后旧回调仍会追加；CC 有 `query_id` 保护 |
| T2-6 | 任务运行中修改目标输入不改变本任务后续请求 | FAIL | 实测：CC 在索引之间调用 `_load_cc_page()` 重新读取输入框（`main.py:1558-1560`），首索引用冻结域名、后续索引改用新输入（探测输出：`('CC-MAIN-A','original.example.com',1)` → `('CC-MAIN-A','new.example.com',1)`） |
| T2-7 | 旧任务事件不污染新结果 | FAIL（Wayback）；PASS（CC） | CC 三个回调均有 `query_id != _active_query_id` 守卫；Wayback 无 |
| T2-8 | 在途请求可停止；重试等待感知取消 | BLOCKED/GAP | `requests` 为阻塞 I/O；`_request_with_retry` 的 `time.sleep` 不检查停止事件（`api_client.py:61-81`）。只能承诺“停止安排后续请求”，不能承诺即时中断 |
| T2-9 | 部分完成/失败后已收记录可导出 | PASS | 数据层保留记录；导出用例覆盖任意筛选快照 |
| T2-10 | 完成/部分完成/失败/已停止终态可区分 | PARTIAL | 回调层状态文案已自动验证；界面呈现需 GUI 验收 |

## T3 索引时间与不完整结果（P0）

| ID | 验收项 | 状态 | 证据/说明 |
|---|---|---|---|
| T3-1 | 最近 N 个月（固定时钟，含跨年） | PASS（公式行为）；BLOCKED（真实覆盖） | `test_recent_months_uses_observed_week_to_month_formula`、`test_recent_months_across_a_year_boundary`；公式把 `CC-MAIN-YYYY-NN` 的 `NN` 当 ISO 周号，见 T3-11 |
| T3-2 | 指定年月（含跨年） | PASS（公式行为）；BLOCKED（真实覆盖） | 固定时钟 2025-09-15 下 `2024-10` 选中 `CC-MAIN-2024-38`（`(38-1)//4+1 == 10`），不代表该索引真实覆盖 2024 年 10 月 |
| T3-3 | 全部时间返回全部索引且保持来源顺序 | PASS | `test_all_time_returns_every_index_in_source_order` |
| T3-4 | 页数来自服务端 `showNumPages` 元数据 | PASS | `test_page_count_comes_from_service_metadata`；请求含 `showNumPages=true&pageSize=5` |
| T3-5 | 3 个索引中 1 个失败：保留另 2 个结果并列出失败索引 | PASS | `test_one_of_three_indexes_failing_keeps_other_results` |
| T3-6 | 全部索引失败显示失败 | PASS | `test_all_indexes_failing_reports_failure` |
| T3-7 | 达到每索引 5 页上限显示不完整及原因 | PASS | `test_page_cap_is_reported_as_incomplete`；状态含“部分完成/5 页上限” |
| T3-8 | 解析丢行显示不完整及原因 | FAIL | `api_client.py:316-320` 静默 `continue`，结果无丢行计数/状态；夹具 `cc_page_0.ndjson` 含 1 行非法 JSON，解析后无任何不完整提示 |
| T3-9 | `pageSize` 表达压缩索引块数而非 URL 条数 | PASS | 代码与界面文案一致（README、`main.py:1527`） |
| T3-10 | Wayback 分页使用确定性夹具验证无遗漏/重复循环 | PARTIAL | 分页循环与上限已自动验证；`has_more` 仍由 `len(results) >= page_size` 推断（`api_client.py:167`），无服务端总数，存在边界误判风险 |
| T3-11 | 月份规则与来源契约一致（不得凭假设宣称覆盖完整） | BLOCKED | 代码未使用 `collinfo.json` 的 `cdx-api`/覆盖时间；`CC-MAIN-2024-38 → 2024-10` 只是周号近似。需要官方契约或批准样本后再定义 |

## T4 结果工作区（P0）

| ID | 验收项 | 状态 | 证据/说明 |
|---|---|---|---|
| T4-1 | `set_results` 同批重复 URL 只保留首条 | PASS | `test_set_results_keeps_first_record_per_url` |
| T4-2 | `append_results` 跨批重复 URL 只保留已有首条 | PASS | `test_append_dedupes_against_already_stored_urls` |
| T4-3 | `append_results` 新批次内部重复也只保留一条 | FAIL | 基线只按“已有 URL”过滤，未在批次内去重（`main.py:533-538`） |
| T4-4 | 筛选后继续追加数据，所有可见记录仍满足条件 | FAIL | `append_results` 将 `filtered_results` 重置为 `all_results`（`main.py:539`） |
| T4-5 | 清除筛选恢复全量并清空控件 | PASS | `test_clear_filters_restores_the_full_result_set` |
| T4-6 | 切换筛选条件回到合法页 | PASS | `_apply_filters` 将 `current_page` 归零 |
| T4-7 | 排序作用于全部筛选结果，而非当前页 | PASS | 70 条筛选结果、每页 20 条时排序 70 条 |
| T4-8 | 摘要数字等于实际记录数 | NOT RUN | 需要 GUI 渲染；视图代码用 `len(filtered_results)`，待界面验收确认显示 |
| T4-9 | 排序不得通过列表别名改变原始集合 | GAP | 未筛选时 `filtered_results is all_results`，原地排序会改变原始顺序（`main.py:874`）；不属已采纳 T4 措辞，列为风险 |
| T4-10 | 结果集为唯一 URL 清单（首条保留） | PASS（`set_results`）；FAIL（增量路径见 T4-3） | 与需求“唯一 URL、首条保留”一致 |

## T5 导出与复制（P0；复制为 P1）

| ID | 验收项 | 状态 | 证据/说明 |
|---|---|---|---|
| T5-1 | 120 条固定记录筛为 70 条、每页 20 条，从任一页导出 CSV/JSON 均为 70 条 | PASS | `test_export_includes_all_filtered_records_not_just_visible_page`（当前页设为第 5 页） |
| T5-2 | 筛选为零：CSV 仅表头，JSON 为 `[]` | PASS | `test_empty_filtered_set_exports_header_only_csv_and_empty_json` |
| T5-3 | 导出字段与基线实际输出一致：5 个数据字段，无行号、无 `source` | PASS | 实测字段顺序 `timestamp,status_code,length,file_type,url`；CSV 为 UTF-8 BOM；JSON 为对象数组 |
| T5-4 | 中文、逗号、换行可回读 | PASS | CSV 引号转义与 JSON UTF-8 均实测 |
| T5-5 | 取消保存不生成文件、不提示成功 | PASS | `test_cancelled_save_dialog_writes_nothing_and_reports_nothing` |
| T5-6 | 写入失败提示错误而非成功 | PASS | `test_write_failure_reports_error_not_success` |
| T5-7 | `Ctrl+C`/右键复制（P1） | NOT RUN | 需要 GUI 剪贴板与选择行 |
| T5-8 | 真实界面筛选后导出与界面一致 | NOT RUN（数据层 PASS） | 需 GUI 端到端；数据层已证明导出读取 `filtered_results` 快照 |

**“五字段 / 六列”分歧的基线结论**：内部记录有 6 个键（含 `source`），表格显示 6 列
（含行号 `#`），而 CSV/JSON 实际只导出 **5 个数据字段**（不含 `source`、不含行号）。
导出契约以此为准；若重构要新增字段，应按架构建议使用显式新格式版本，不能默默改变旧文件结构。

## T6 启动、体验与交付（P0）

| ID | 验收项 | 状态 | 证据/说明 |
|---|---|---|---|
| T6-1 | 干净环境按文档创建 `.venv`、安装依赖并启动 | PASS | Python 3.13.15 + uv 0.12.13；`uv venv`、`uv pip install -r requirements.txt`、`startup_smoke.py` 输出 `STARTUP_SMOKE_OK` |
| T6-2 | 缺少 Tkinter/依赖时提示具体补救步骤 | NOT RUN | 未破坏当前环境实测；静态核对：两个启动脚本会提示安装命令，但都强制检查未使用的 `pandas`（`start.bat:49`、`start.sh:25`、`requirements.txt:3`） |
| T6-3 | 用本地夹具完成端到端验收并记录环境/结果/未覆盖项 | NOT RUN | 夹具与数据层测试已就绪；GUI 端到端需人工/后续界面提交 |
| T6-4 | README 与实际行为一致 | FAIL | “两来源互不阻塞”与实际串行禁用两入口不符（`main.py:1286-1292`）；“滚动自动加载下一个索引”实际为完成即自动接续；`pandas` 列为技术栈但业务未使用；时间范围与“按月索引”为近似公式（T3-11） |
| T6-5 | 1366×768、浅/深主题可操作 | NOT RUN | 属界面方案与后续 GUI 验收；本轮未做视觉检查 |
| T6-6 | macOS / Linux 支持 | NOT VERIFIED | README 宣称支持，仅有 Windows 实测；其他平台必须标注未验证 |
| T6-7 | 依赖可复现 | GAP | `requirements.txt` 未锁定版本；本轮安装到 `customtkinter 6.0.0 / requests 2.34.2 / pandas 3.1.1`，未来结果可能漂移 |

## 后续对开发提交执行验收的规则

1. 在干净 venv 中先运行既有测试：`python -m unittest discover -s tests -v`，必须全绿。
2. 再运行本目录：`python -m unittest discover -s acceptance -v`。
   基线 14 个失败（T1-3/4、T4-3/4）是重构必须消除的项；其余用例不得回归。
3. `BLOCKED`/`NOT RUN` 项必须补充人工 GUI 记录或来源契约证据，不能用自动化绿灯替代。
4. 不得删除或弱化用例来“通过”验收。若重构有意改变接口，只允许调整测试适配层，
   并在提交说明中记录原因与等价断言。
5. 验收通过的最低条件：T1–T6 所有 P0 项为 PASS，或由需求方书面接受剩余风险；
   跨平台与主题项至少明确标注“未验证”。
