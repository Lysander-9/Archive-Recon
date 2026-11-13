# NEPT-3 基线验收报告

- 仓库：`https://github.com/Lysander-9/Archive-Recon.git`
- 基线提交：`8e6aaf9fc810d29011c4a61233e22aa7fabcc378`（`Make the project portable and self-contained`）
- 测试分支：`agent/agent/133403d1c75a`
- 执行日期：2026-11-13
- 执行性质：独立验收准备；未修改业务代码、未修改 `tests/`、未访问 Wayback Machine / Common Crawl

## 1. 环境与启动基线

| 项目 | 实际值 |
|---|---|
| 操作系统 | Windows 11 Pro 10.0.26300（win32） |
| Python | 3.13.15（MSC v.1944 64-bit），tkinter 8.6 |
| 虚拟环境 | `.venv`（`uv venv .venv`） |
| 依赖安装 | `uv pip install --python .venv/Scripts/python.exe -r requirements.txt` |
| 实际安装版本 | customtkinter 6.0.0、requests 2.34.2、urllib3 2.8.0、certifi 2026.10.23、charset-normalizer 3.5.2、idna 3.20、pandas 3.1.1、numpy 2.5.4、python-dateutil 4.0.0、packaging 26.3、darkdetect 0.8.0、tzdata 2026.6 |
| 网络访问 | 未访问任何存档来源；所有 HTTP 在客户端边界被夹具替换 |

复现命令：

```powershell
uv venv .venv
uv pip install --python .venv\Scripts\python.exe -r requirements.txt
.venv\Scripts\python.exe -m unittest discover -s tests -v
.venv\Scripts\python.exe acceptance\startup_smoke.py --hold-ms 1200
.venv\Scripts\python.exe -m unittest discover -s acceptance -v
```

GUI 启动冒烟（真实窗口，1.2 秒后自动关闭）：

```text
STARTUP_SMOKE_OK hold_ms=1200 elapsed_s=2.00
```

结论：当前 Windows 环境可以按 README 的虚拟环境流程启动；未验证 macOS/Linux。

## 2. 既有测试结果（基线）

```text
python -m unittest discover -s tests -v
Ran 12 tests in 0.002s
OK
```

说明：架构/需求 Agent 此前在未安装依赖的环境中看到两个测试模块导入失败；安装
`requirements.txt` 后 12 个测试全部通过。既有测试只覆盖：

- `_normalize_domain` 的 6 个用例（合法 plain/wildcard、协议与 `/`、路径、端口、畸形端口、空值）；
- Common Crawl 分页/页数/过滤参数/多索引上限的 6 个用例。

没有覆盖：CSV/JSON 字段契约、结果域名筛选、增量去重、筛选保持、导出快照、停止、
时间范围选择、畸形行、README 一致性。因此“既有测试全绿”不能证明核心工作流可用。

## 3. 新增验收测试结果（基线，离线）

```text
python -m unittest discover -s acceptance -q
Ran 67 tests in 0.066s
FAILED (failures=14)
```

| 模块 | 用例数 | 基线结果 | 说明 |
|---|---:|---|---|
| `test_t1_domain_contract` | 11 | 12 个子测试失败 | 4 个非法输入（2 个 userinfo、2 个内部空白）被接受，且两来源都会启动线程 |
| `test_t2_query_lifecycle` | 17 | OK | 夹具解析、分页循环、20 页上限、停止、有界重试、CC 旧任务守卫 |
| `test_t3_period_and_completeness` | 14 | OK | 固定时钟公式、跨年、服务端页数、部分失败/截断状态 |
| `test_t4_result_workspace` | 13 | 2 个失败 | `append_results` 未做批次内去重；追加后丢弃筛选 |
| `test_t5_export_contract` | 9 | OK | 真实落盘验证五字段、BOM、JSON、全量筛选快照、取消/写失败 |
| `test_t6_startup_contract` | 3 | OK | 导入入口与依赖声明 |

这 14 个失败全部是**基线行为缺陷**，不是环境异常；它们编码了已采纳的 T1/T4
验收要求，重构提交应使其转绿。其余 53 个用例作为回归护栏。

## 4. 实测契约（基线实际输出，不是推断）

### 4.1 CSV / JSON 导出字段

用真实记录调用 `ResultsTable._export_csv/_export_json`（仅替换文件对话框），
实际落盘结果：

- 内部记录键（两个来源统一）：`url, status_code, length, file_type, timestamp, source`（6 个）；
- 表格显示列：`#（行号）, timestamp, status_code, length, file_type, url`（6 列）；
- **CSV 表头与 JSON 键均为 5 个数据字段，顺序固定**：
  `timestamp,status_code,length,file_type,url`；
- 不导出 `source`，不导出表格行号；
- CSV：UTF-8 BOM（`EF BB BF`）、`csv.DictWriter`、逗号/换行/中文可回读；
- JSON：UTF-8、`ensure_ascii=False`、`indent=2` 的对象数组；
- `timestamp` 在标准化阶段已截断为日期（`YYYY-MM-DD`），原始时分秒不保留。

因此“五字段 / 六列”的分歧应按**导出 5 字段、界面 6 列、内部 6 键**理解；
导出兼容必须以 5 字段为准，不能用“六列”作为导出完成依据。

### 4.2 域名匹配语义

输入规范化（`main.py:1458`，实测）：

| 输入 | 结果 |
|---|---|
| `example.com` / `EXAMPLE.com` / ` example.com ` | `example.com` |
| `*.example.com` / `https://*.example.com/` | `*.example.com` |
| `https://Example.com/` / `http://example.com` | `example.com` |
| 空串 / 全空白 | 拒绝，提示请输入目标域名 |
| 路径 / 查询 / 片段 | 拒绝 |
| 端口 / 畸形端口 | 拒绝 |
| `ftp://` / 空 host / 尾点 / 首尾连字符标签 | 拒绝 |
| `user:pass@example.com`、`https://user:pass@example.com/` | **接受**（返回 `example.com`） |
| `exa mple.com`、`example .com` | **接受**（内部空白保留在 host） |

请求构造（用记录 URL 的假传输实测）：

- Wayback：`url=example.com&matchType=domain&output=json&fl=urlkey,timestamp,original,mimetype,statuscode,digest,length&collapse=urlkey&limit=50`；
  `example.com` 与 `*.example.com` 生成**完全相同**的 query；第 2 页追加 `page=1`。
- Common Crawl：`url=*.example.com&pageSize=5&page=0&output=json`；
  页数查询为 `url=*.example.com&pageSize=5&showNumPages=true&output=json`；
  plain 与 wildcard 输入同样生成相同 query。
- 结论：两个来源在**客户端请求层**表达同一“根域 + 子域”意图；服务端是否把
  `matchType=domain` / `url=*.` 解释为包含裸域和全部子域，本轮无法离线核实（见阻塞项）。

结果域名筛选（`main.py:699`，实测）：

- `example.com` 匹配 `example.com`、`www.example.com`、`a.b.example.com`；
- 不误匹配 `badexample.com`、`example.com.evil.com`；
- `*.example.com` 等同 `example.com`；
- 排除项优先于包含项；无包含项时全部通过；
- 注意：显式 `www.example.com` 也会匹配 `a.www.example.com`（代码按后缀匹配，
  与注释“精确匹配 hostname”不完全一致）。

### 4.3 时间范围与索引选择

用固定时钟与合成 `collinfo.json` 实测（仅记录当前公式行为）：

- `datetime.now() = 2025-09-15`，`months=3` → cutoff `202506` → 返回
  `CC-MAIN-2025-38, CC-MAIN-2025-30, CC-MAIN-2025-26`；
- `datetime.now() = 2025-01-15`，`months=3` → cutoff `202410` → 返回 7 个 2025 索引
  加 `2024-51/43/38`；
- 指定 `2024-10` → `CC-MAIN-2024-38`，因为 `(38-1)//4+1 == 10`；
- 指定 `2023-12` → `CC-MAIN-2023-50`；
- 全部时间返回 19 个索引，保持来源顺序；年份过滤为 id 子串匹配。

该公式把 `CC-MAIN-YYYY-NN` 的 `NN` 当作 ISO 周号换算月份，且完全忽略
`collinfo.json` 的 `cdx-api` 等覆盖元数据。**不能据此宣称某索引真实覆盖某自然月**。

### 4.4 重试与解析

- `max_retries=2` 实际为 **2 次总尝试**（1 次 0.5 秒等待），随后抛出
  `APIError("Request failed after 2 retries: ...")`；命名与含义不一致。
- 429 会等待后重试；等待使用 `time.sleep`，不感知停止事件。
- Common Crawl 逐行解析遇到非法 JSON 时静默 `continue`（`api_client.py:316-320`），
  无丢行计数或“不完整”提示；夹具 `cc_page_0.ndjson` 故意含 1 行非法 JSON，
  解析结果 4 条，状态无任何提示。
- Wayback `has_more` 由 `len(results) >= page_size` 推断（`api_client.py:167`），
  不是服务端总数；最后一页恰好满页时可能多发一次请求。

## 5. 基线缺陷与严重度

| # | 严重度 | 缺陷 | 证据 | 期望 |
|---|---|---|---|---|
| D1 | 高 | Common Crawl 任务在索引之间重新读取输入框，运行中改目标会让同一任务混入新目标 | 实测 `_load_cc_page()` 前后线程参数：`original.example.com` → `new.example.com`；`main.py:1558-1560` | 任务开始时冻结目标，后续索引只用冻结值 |
| D2 | 高 | Wayback 迟到批次没有任务归属，停止后立即重启可能把旧任务结果写入新任务 | `_on_wayback_batch` 仅检查 `_stop_event`（`main.py:1390`）；新查询会 `clear()` 停止事件（`main.py:1288-1289`）；CC 三个回调均有 `query_id` 守卫 | 所有来源事件携带 job id，结束/过期事件丢弃 |
| D3 | 高 | `append_results` 不消除新批次内部重复 URL | `main.py:536-538` 仅用 `existing_urls` 过滤；实测同批两个同 URL 均保留 | 唯一 URL 集合，首条保留 |
| D4 | 高 | `append_results` 把 `filtered_results` 重置为全量，增量加载后筛选失效 | `main.py:539`；实测追加 404 后可见集合包含 404 | 追加后保持当前筛选（或明确重算） |
| D5 | 中 | 含用户信息的输入被接受并用于查询 | 4 个子用例；`urlsplit` 的 `hostname` 丢弃 userinfo | T1 要求拒绝，错误提示不启动任务 |
| D6 | 中 | 域名内部空白被接受 | `exa mple.com`、`example .com` 实测通过 IDNA/标签检查 | T1 要求拒绝 |
| D7 | 中高 | Common Crawl 解析丢行无任何“不完整”提示 | `api_client.py:316-320`；夹具实测 | 结果状态包含丢行数量/原因 |
| D8 | 中高 | 月份规则无来源契约依据，忽略 `collinfo` 覆盖元数据 | `api_client.py:234-259`；固定时钟实测公式 | 先核实契约，未核实时明确标注近似/未验证 |
| D9 | 中 | Wayback 分页 `has_more` 由行数推断，边界可能多请求/误判 | `api_client.py:167` | 用确定性契约或分页元数据定义结束条件 |
| D10 | 中 | 无筛选时排序原地修改 `all_results`（列表别名） | `main.py:874`；`filtered_results is all_results` | 排序不改变原始集合，或明确其为唯一数据源 |
| D11 | 中 | 在途请求无法取消，重试等待不感知停止 | `api_client.py:61-81`；`requests` 阻塞 | 停止只承诺“不再安排后续请求”，界面显示停止中，不宣称即时中断 |
| D12 | 低 | README 与实际不一致：两来源“互不阻塞”、滚动加载 vs 自动接续、“按月索引”、pandas 未使用却被启动脚本强制检查 | `README.md:9,14,16,136`；`main.py:1286-1292`；`start.bat:49`；`start.sh:25` | 文档按实际串行/自动接续/近似时间规则更新，依赖检查与真实依赖一致 |
| D13 | 低 | `max_retries=2` 实为 2 次总尝试，错误文案称 “after 2 retries” | `api_client.py:64-81`；实测 0.5 秒、2 次调用 | 命名/文案与实际一致，避免运维误解 |
| D14 | 信息 | 导出契约存在“五字段/六列”歧义 | 实测：内部 6 键、表格 6 列、导出 5 字段 | 以 5 字段导出为准；新增字段用显式格式版本 |

## 6. 阻塞与未覆盖

1. **来源契约未核实（BLOCKED）**：`matchType=domain` 的子域语义、CC `*.` 是否含裸域、
   `CC-MAIN-YYYY-NN` 的真实覆盖时间，均需要官方文档或经批准的固定响应；本轮按
   要求不访问外部目标，不能自行假设。
2. **GUI 端到端未执行（NOT RUN）**：状态提示、筛选分页、小窗口、浅深主题、剪贴板
   复制需要人工或后续界面提交；本轮只验证了启动冒烟和回调层状态文本。
3. **缺依赖启动提示未实测（NOT RUN）**：为避免破坏当前环境，仅静态核对启动脚本。
4. **跨平台未验证（NOT VERIFIED）**：本轮只有 Windows 实测。
5. **性能未测（NOT RUN）**：10,000 条样本的筛选/分页/导出延迟不在本轮范围。
6. **既有测试覆盖不足**：12 个通过用例不能作为核心工作流可用的证据。

## 7. 交付与非结论

本轮新增仅限 `acceptance/`（测试、夹具、说明、报告），未修改业务代码或 `tests/`。
提交见本分支最新 commit 与最终评论。

**明确非结论**：基线结果只用于建立可复现起点和验收契约；14 个失败是重构需要
修复的基线缺口，53 个通过用例只证明相应基线行为，不证明重构版本通过。必须对
开发提交重新执行本清单后方可判定验收结果。
