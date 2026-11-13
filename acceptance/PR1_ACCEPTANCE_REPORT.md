# PR #1 独立离线验收报告（固定提交 6349a0e）

- PR：`https://github.com/Lysander-9/Archive-Recon/pull/1`
- 被测提交：`6349a0ea3970ab7e5d487aadaace73d22fd7b9cc`（PR head，分支 `agent/agent/c5d8bc2f4e21`）
- 基线对照：`8e6aaf9fc810d29011c4a61233e22aa7fabcc378`（见 `BASELINE_REPORT.md`）
- 执行日期：2026-11-13
- 执行性质：独立离线验收；使用 `acceptance_pr1/` 自有断言，不采信开发自测作为兼容性依据；未访问 Wayback Machine / Common Crawl

## 1. 环境与执行

| 项目 | 实际值 |
|---|---|
| 平台 | Windows 11 Pro 10.0.26300，仅 Windows |
| Python | 3.13.15（MSC v.1944 64-bit），tkinter 8.6 |
| 被测代码 | 提交 `6349a0e` 解压到独立目录，`ARCHRECON_ROOT` 指向该目录 |
| 独立环境 | `uv venv .venv-pr1` + `uv pip install -r requirements.txt`；仅 customtkinter 6.0.0、requests 2.34.2 及传递依赖；**pandas 不存在** |
| 网络 | 全部 HTTP 在 `_request_with_retry` 边界替换为合成夹具 |

执行的命令与结果：

```text
# 开发方自测（仅记录，不作为验收依据）
python -m unittest discover -s tests -q
Ran 76 tests in 1.266s
OK

# 独立 PR #1 验收
python -m unittest discover -s acceptance_pr1 -q
Ran 63 tests in 0.064s
FAILED (failures=13)

# GUI 启动冒烟
python acceptance/startup_smoke.py --hold-ms 1200
STARTUP_SMOKE_OK hold_ms=1200 elapsed_s=2.20
```

模块结果：

| 模块 | 用例 | 结果 | 说明 |
|---|---:|---|---|
| `test_pr1_domain.py` | 10 | 12 个子测试失败 | T1 userinfo / 内部空白仍被接受，两来源都会启动 |
| `test_pr1_jobs.py` | 13 | 1 个失败 | CC 任务索引之间重新读取输入框（T2） |
| `test_pr1_export.py` | 9 | OK | 五字段导出、BOM、快照、取消/失败路径 |
| `test_pr1_results.py` | 17 | OK | 同批/跨批去重、筛选保持、排序不改变原始集合 |
| `test_pr1_period.py` | 8 | OK | 时间公式、页数元数据、重试；丢行仍静默 |
| `test_pr1_docs.py` | 6 | OK | 导出常量、打包检查 |

## 2. 五字段导出对照（重点）

将基线版本与 PR #1 用**同一组记录**（中文、逗号、换行、source、raw_timestamp）
分别导出，然后逐字节比较：

| 文件 | 基线 SHA-256 | PR #1 SHA-256 | 结论 |
|---|---|---|---|
| CSV | `5a8f28e8cd917225efe8e2c00b2a8873207fdb469394e00fc1bc94cb3b8f48f4` | 同左 | 字节级一致 |
| JSON | `2d201fda5583a11eedad25fbe3007011c216ceda064c0861ffd7c73083694b05` | 同左 | 字节级一致 |

实测 PR #1 语义：

- CSV：UTF-8 BOM（`EF BB BF`），表头 `timestamp,status_code,length,file_type,url`；
- JSON：UTF-8 对象数组，键顺序相同，`ensure_ascii=False`，两空格缩进；
- `source`、`raw_timestamp` 只保留在 `ArchiveRecord` 内部，不进入导出；
- `ResultsTable._export_csv/_export_json` 调用 `collection.snapshot()`，导出筛选后全部记录，不受当前页影响；
- 空集合：CSV 仅表头、JSON `[]`；取消不写文件；写入失败走 `AppError` 错误提示；
- 原子写入：临时文件 + `os.replace`，成功后无 `.archrecon-*` 残留。

**结论：五字段兼容要求已满足，且有字节级证据。**

但文档/注释仍写“六列”，与用户确认的五字段契约矛盾：

- `archrecon/models.py:3-4`：`CSV / JSON 固定六列`；
- `archrecon/exporter.py:1`：`导出实现：CSV / JSON 固定六列`；
- `docs/archrecon-core.md:19,48,96,107`：`六列导出字典`、`六列表头`、`保持既有六列`。

功能行为正确，文档表述错误；这会误导后续 UI 与验收，必须修正为“五个数据字段”。

## 3. 已修复并验证的项

| 验收项 | 证据 |
|---|---|
| T4-1/2/3 同批与跨批重复 URL 只保留首条 | `test_pr1_results.py`：`ResultCollection` 新批次内部也去重，`AppendOutcome` 统计正确 |
| T4-4 追加后保持筛选 | 筛选 200 后追加 404/200，视图仍只含 200，原始集合增长到 5 |
| T4-5/6/7/9 清除筛选、分页重置、全量排序、排序不改原始集合 | `ResultCollection.view` 为派生元组；`sort_records` 返回新列表 |
| T2 旧任务事件不污染新任务 | Wayback/CC 全部回调带 `job_id`；`JobCoordinator` 只接受 active job；被取代任务进入 `stopped` |
| T2 停止后不再安排后续页并保留记录 | 实际执行 `_do_wayback_query`：停止后只请求第 0 页，记录保留，状态 `stopped` |
| T2 终态不再接收数据 | 终态 `accepts_data == False`；重复 `finish` 幂等；非法转换抛 `InvalidJobTransition` |
| T2 停止文案不承诺即时中断 | `_stop_query` 显示“正在停止...（等待当前请求返回）” |
| T3 部分失败/全部失败/5 页上限 | 3 索引 1 失败保留 2 条并列出失败索引；全部失败 `FAILED`；截断 `PARTIAL` 并列出索引 |
| T6 干净环境启动 | 无 pandas 的独立 venv 中 76 个开发测试、独立验收套件与 GUI 冒烟均可运行 |
| T6 依赖清理 | `requirements.txt`、`start.bat`、`start.sh` 已移除 pandas，README 技术栈改为 `archrecon` |

主线程规则：三个后台 worker（`_do_wayback_query`、`_prepare_cc_query`、
`_do_cc_page_query`）只通过 `self.after(...)` 投递回调，未在 worker 内直接操作控件；
`docs/archrecon-core.md:105` 已声明仍使用 `Widget.after`、尚未改为有界队列。
按“控件更新留在主线程”的要求可判 PASS；有界队列属于未完成优化项。

## 4. 缺陷（行为与已采纳 P0 要求冲突）

| # | 严重度 | 缺陷 | 位置 | 复现/证据 |
|---|---|---|---|---|
| P1 | 高 | 含用户信息的输入仍被接受并启动查询 | `main.py:1385-1408`（`_normalize_domain` 未改）；两个入口在 `main.py:1201`、`:1360` 调用 | `acceptance_pr1/test_pr1_domain.py` 12 个失败；`user:pass@example.com` → `example.com`，线程被调用 |
| P2 | 高 | Common Crawl 任务运行中修改目标，会改变同一任务后续索引请求 | `_prepare_cc_query` 丢弃 domain（`main.py:1424`）；`_on_cc_indexes_ready` 只收 `job_id`（`main.py:1444`）并调用 `_load_cc_page(job_id=...)`（`:1464`）；`_load_cc_page` 在 `domain is None` 时重读输入框（`:1503-1504`） | 实测线程参数：任务开始目标 `original.example.com`，把输入改成 `new.example.com` 后回调得到 `('CC-MAIN-A','new.example.com',...)` |
| P3 | 中 | 文档/注释宣称“六列导出”，与用户确认的五字段契约冲突 | `archrecon/models.py:3-4`；`archrecon/exporter.py:1`；`docs/archrecon-core.md:19,48,96,107` | 代码实际输出五字段，字节级对照通过；文档必须改为五字段 |
| P4 | 中 | 域名内部空白仍被接受 | 同 P1 | `exa mple.com`、`example .com` 被接受并启动 |

P1/P4 属于基线未修复项，不是 PR #1 新引入的回归；但 T1 是已采纳 P0，当前不能判过。

## 5. 未实现的验收项（不属于回归，但阻塞整体通过）

| 验收项 | 状态 | 说明 |
|---|---|---|
| T1-7 来源端匹配语义核实（`matchType=domain`、CC `*.` 是否含裸域） | BLOCKED | 本轮不访问外部目标，仓库无离线权威契约；需官方文档或批准的录制响应 |
| T3-8 解析丢行显示不完整及原因 | 未实现 | `api_client.py:316-320` 仍静默 `continue`；`test_pr1_period.py` 证实结果无 `dropped_lines`/`completeness` |
| T3-11 月份规则与来源契约一致 | BLOCKED/未实现 | 仍按 `(NN-1)//4+1` 近似，忽略 `collinfo.json` 覆盖元数据；PR #1 文档称其不在本批范围 |
| T3-10 Wayback `has_more` 正确性 | PARTIAL | 仍由 `len(results) >= page_size` 推断，无服务端总数 |
| T2-8 在途请求即时取消 | 已知限制 | `requests` 阻塞；重试等待不感知停止；`docs/archrecon-core.md:106` 已声明 |
| T5-7 复制功能（P1） | NOT RUN | 需要 GUI 剪贴板与选择行 |
| T5-8 真实界面筛选→导出 | NOT RUN（数据层 PASS） | 需 GUI 端到端 |
| T6-2 缺依赖启动提示 | NOT RUN | 静态核对：脚本已移除 pandas，提示命令仍正确 |
| T6-3 本地夹具端到端 | NOT RUN | 需 GUI 手工执行 |
| T6-4 README 与实际一致 | 部分未实现 | pandas 行已改；`README.md:14`“两来源可独立查询，互不阻塞”、`:16`“滚动到底部自动加载”仍与实际串行/自动接续不一致；新核心文档“六列”见 P3 |
| T6-5 1366×768 / 浅深主题 | NOT RUN | 属后续界面提交 |
| T6-6 macOS / Linux | NOT VERIFIED | 仅 Windows 实测 |
| 性能（10,000 条） | NOT RUN | 不在本轮范围 |

## 6. 观察项与风险

1. `ResultCollection.reset()` 保留当前筛选与排序；新查询开始时 `set_results([])` 后，
   新结果会立即套用上一次的筛选控件值。行为可能符合“条件保持”，但需 UI 验收确认
   是否与用户预期一致。
2. 空 URL 记录现在会被保留（基线 `set_results` 会丢弃）；若来源返回空 URL，界面可能
   出现空行。核心文档称有意“避免静默丢数据”，建议 UI 层明确处理。
3. `JobCoordinator` 永久保留每次任务的 `QueryJob`，长时间多次查询会累积少量对象；
   当前不构成功能缺陷，列为低风险。
4. `docs/archrecon-core.md:107` 声明 CSV 未做公式注入转义；与基线一致，但导出文件
   若被表格软件打开仍有风险，需产品确认是否属于首版范围。

## 7. 结论

- **不能判定 PR #1 整体验收通过。**
- 五字段导出兼容**已满足**：与基线样本逐字节一致（CSV/JSON 哈希相同），BOM、
  原子写入、筛选快照、取消/失败路径均通过。
- 结果集合与任务归属的主要修复**已验证有效**：同批/跨批去重、筛选保持、排序隔离、
  旧事件丢弃、终态保护、部分失败保留均通过。
- 仍存在 2 个 P0 行为缺陷（T1 userinfo/内部空白、T2 CC 目标冻结）、1 个文档契约错误
  （“六列”），以及 T3 丢行可见性、来源契约核实、GUI/跨平台等未实现/未覆盖项。
- 建议后端先在现有 PR 分支修复 P1/P2/P3/P4 并补对应回归；UI 提交返回后，再对集成
  版本运行 `tests/` + `acceptance/` + `acceptance_pr1/`，并补齐 GUI、主题、跨平台证据。
