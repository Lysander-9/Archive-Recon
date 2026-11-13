# archrecon 核心层接口（首版）

本文件记录 NEPT-3 首版实现的核心接口，供后续界面改造与独立测试对接。
所有接口只依赖标准库，可直接在无 GUI 依赖的离线环境导入。

```python
import archrecon  # 包入口，导出下列全部公开名称
```

## 1. 数据模型

### `ArchiveRecord`

不可变记录，字段：`url`、`status_code`、`length`、`file_type`、`timestamp`、
`source`、`raw_timestamp`。其中 `source` 与 `raw_timestamp` 仅内部使用，不导出。

- `ArchiveRecord.from_mapping(mapping)`：接受既有标准化字典，也兼容
  `original` / `statuscode` / `mimetype` 等原始字段名，非字符串值自动转字符串。
- `to_export_row()`：导出字典，**固定五个数据字段**，键顺序固定
  `timestamp, status_code, length, file_type, url`；不含界面行号 `#`，
  也不含 `source` / `raw_timestamp`。
- `value_of(column)`：读取任意界面列，未知列返回空串。
- `to_mapping()`：包含 `source`、`raw_timestamp` 的完整字典（仅内部使用）。

`EXPORT_COLUMNS` 为导出字段顺序常量（5 项），`DISPLAY_COLUMNS` 为界面数据列
（同为 5 项，渲染时行号 `#` 另加）。

### 错误

`AppError(code, message, *, source=None, retryable=False, context=None)`，
`ErrorCode` 取值：`input / network / response / parse / export / internal`。
导出失败以 `ErrorCode.EXPORT` 抛出，界面据此提示。

### 目标域名校验

```python
from archrecon import normalize_domain, parse_domain, DomainTarget, AppError, ErrorCode

host, error = normalize_domain("https://Example.com/")   # ("example.com", None)
target = parse_domain("*.example.com")                    # DomainTarget(host="*.example.com", wildcard=True)
```

- `normalize_domain(value) -> (host, error)`：与 `main` 既有静态方法同签名，
  可直接替换；校验失败返回 `("", 中文提示)`。
- `parse_domain(value) -> DomainTarget`：失败抛 `AppError(ErrorCode.INPUT)`，
  成功返回 `host` 与 `wildcard`；`as_dict()` 便于日志。
- 允许：裸域、`*.` 通配、http/https 前缀、末尾 `/`、大小写混写、首尾空白（去除）。
- 拒绝：空值、路径 / 查询 / 片段、端口、非法标签、IDN 编码失败；
  **以及基线会误接受的两类输入**：
  - 用户信息：`user:pass@example.com`、`https://user:pass@example.com/`；
  - 域名内部空白：`exa mple.com`、`example .com`（含制表符 / 不间断空格等）。

### 不完整原因

```python
from archrecon import IncompleteCode, IncompleteReason, summarize_reasons

reason = IncompleteReason(
    code=IncompleteCode.PARSE_LINE, message="1 行响应无法解析，已跳过",
    source="commoncrawl", index_id="CC-MAIN-2024-10", page=0, count=1,
    context={"line_numbers": (5,)},
)
reason.to_dict()        # 可直接放入任务/结果 payload
summarize_reasons([...])  # 单行摘要
```

`IncompleteCode`：`parse_line / parse_record / network / page_limit /
record_limit / stopped / unknown`。原因说明“为什么结果不完整”，
不改变已解析记录的可用性。

## 2. 结果集合 `ResultCollection`

```python
collection = ResultCollection(records=None, source_name="wayback")
```

| 成员 | 说明 |
|---|---|
| `records` | 原始集合（只读元组），去重后按接收顺序 |
| `append(records) -> AppendOutcome` | 追加一批记录；同批与跨批重复 URL 只保留首条 |
| `reset(records)` | 用新一批替换全部记录并重新去重 |
| `clear()` | 清空记录，保留筛选与排序条件 |
| `apply_filter(spec) -> int` / `clear_filter() -> int` | 设置/清除筛选，返回匹配数量 |
| `set_sort(column, reverse=False) -> int` / `clear_sort()` | 设置/清除排序 |
| `view` | 当前筛选 + 排序后的只读视图（新集合，不修改 `records`） |
| `page(index, size)` / `page_count(size)` | 分页切片与总页数 |
| `snapshot()` | 导出快照：当前视图全部记录（五字段字典），与界面顺序一致 |
| `total_count` / `view_count` / `urls()` | 统计信息 |

`AppendOutcome`：`added`、`duplicates`、`batch_duplicates`、
`known_duplicates`、`total`。

行为约定：

- 去重按完整 URL 字符串精确比较，不同协议 / 路径 / 查询参数视为不同 URL；
  空 URL 不参与去重，避免静默丢数据。
- 追加不会重置筛选或排序；`records` 顺序始终是接收顺序。
- 排序只作用于派生视图，切换排序或清除排序都不会改变原始集合。

## 3. 筛选与排序

`FilterSpec(status, file_type, url_keyword, domain, interesting_only)`：
逗号分隔多值，`!` 前缀表示排除；文件类型与 URL 为不区分大小写的子串匹配；
域名根域自动包含子域，下拉框的 `host (N)` 后缀会被剥离。

`SortSpec(column, reverse)`；`apply_filter(records, spec)`、
`sort_records(records, spec)` 为纯函数，返回新列表。

`is_interesting_url(url)`、`extract_hostname(url)`、
`match_domain_pattern(s)` 位于 `archrecon.matching`，`main.py` 保留同名静态方法包装。

## 4. 任务与事件归属

```python
jobs = JobCoordinator()
job = jobs.start("commoncrawl", target="example.com")  # target 在任务开始时冻结
jobs.accepts(job.job_id)             # 事件是否属于当前任务
jobs.accepts_data(job.job_id)        # 当前任务是否还能接收数据
jobs.get(job.job_id)                 # 任务对象
job.add_reason(reason_dict)          # 登记/合并结构化不完整原因
jobs.finish_active(JobStatus.PARTIAL, "原因")
```

`QueryJob` 字段：`job_id`、`source`、`target`（任务开始时冻结的查询目标）、
`status`、`received_count`、`unique_count`、`completeness`、`reason`、
`reasons`（结构化不完整原因列表）、`started_at`、`finished_at`、`stop_event`。
方法：`mark_running()`、`request_stop()`、`finish(target, reason)`、
`note_batch(received, unique_total)`、`add_reason(reason)`、`to_dict()`。

`target` 一旦随 `jobs.start(..., target=...)` 传入，后续请求必须使用
`job.target`，不得重新读取界面输入框；这是 CC 任务跨索引保持同一目标的契约。
`add_reason` 对 `(code, index_id, page)` 相同的原因累加 `count`，避免按页刷屏。

状态：`preparing → running → stopping → completed / partial / failed / stopped`。
终态不再接收数据，也不允许再次转换。后台回调必须携带 `job_id` 并在入口处
调用 `accepts` / `accepts_data`，旧任务事件一律丢弃。

## 5. 来源客户端与不完整结果（`api_client`）

`query_wayback` / `query_commoncrawl` 的返回字典在原有键之外新增两个**兼容字段**：

- `parse_skipped: int`：本页被跳过的响应行数（非法 JSON、非对象记录、列数与表头不符）；
- `incomplete_reasons: list[dict]`：与跳过行对应的 `IncompleteReason.to_dict()`，
  含 `code`、`message`、`source`、`index_id`、`page`、`count`、`context`。

可解析记录始终保留在 `results` 中；跳过行不改写为“完整成功”。空响应返回
`parse_skipped=0` 与空原因列表。`total_available` / `has_more` 语义不变。

`APIError(message, *, source=None, index_id=None, retryable=False)` 新增可选字段，
`to_reason(page=None)` 可直接转成结构化失败原因；旧的 `str(error)` 用法不受影响。

核实过的既有边界（本批未改）：

- `_request_with_retry` 的 `max_retries` 是**总尝试次数**（默认 2），不是“额外重试次数”；
- 该请求路径不感知取消，在途请求按 `timeout` 收敛，取消由调用方在请求之间检查；
- 读取上限仍为：Wayback 20 页 × 50 条（`main.py`），CC 每索引最多 5 页、
  `pageSize=5` 个压缩索引块（`main.py`）；`query_wayback_paginated(max_pages)`、
  `query_commoncrawl_multi(max_per_index)` 仍严格受上限约束，未扩大。

## 6. 导出

```python
write_csv(rows, path) -> int    # UTF-8 BOM，五字段表头，原子替换
write_json(rows, path) -> int   # 对象数组，ensure_ascii=False，indent=2
```

导出字段固定为 `timestamp, status_code, length, file_type, url`（5 项）。
行入参即使带有 `source` / `raw_timestamp` / `#` 等额外键，也只会写出上述五个字段。

`rows` 来自 `collection.snapshot()`；导出内容与筛选快照一致，不受当前页影响。
写入失败抛出 `AppError(ErrorCode.EXPORT)`，不会留下临时文件或覆盖原文件。

### 基线兼容证据（8e6aaf9）

以基线分支的 `ResultsTable._export_csv` / `_export_json` 实际执行输出为参照，
使用同一批含中文、逗号、引号、空值的记录对比：

- 基线表头：`timestamp,status_code,length,file_type,url`（5 项）；新实现表头相同；
- CSV（含 UTF-8 BOM）与 JSON 输出**逐字节一致**；
- 基线 JSON 键集合与新实现一致，均不含 `source`、`raw_timestamp`、`#`。

## 7. 已知边界

- 界面仍使用 `Widget.after` 向主线程投递事件，尚未改为有界队列；归属校验已生效。
- 停止依赖在途请求超时收敛，不保证毫秒级中断。
- 导出保持既有五字段输出，未对 CSV 公式注入做转义（与基线输出保持一致）。
- 界面结果表格为 6 列（行号 `#` + 五字段），导出仍为 5 字段。
- `api_client` 的月份近似与日志时区问题不在本批范围。

## 8. 待接线：`main.py`（由前端统一修改，本批未改）

以下三处接线完成后，T1 校验、CC 目标冻结与解析不完整提示才会在界面上生效：

1. **严格校验入口**：把 `ArchiveSearchApp._normalize_domain` 的实现替换为
   核心层同名函数，返回值契约不变：

   ```python
   from archrecon import normalize_domain

   @staticmethod
   def _normalize_domain(value: str) -> tuple[str, str | None]:
       return normalize_domain(value)
   ```

2. **CC 目标冻结**：任务开始时把已校验目标写入任务配置，后续索引请求只读任务：

   ```python
   job = self.jobs.start(source, target=domain)   # _query_starting 接受并透传 target
   ...
   def _on_cc_indexes_ready(self, job_id, index_ids, domain):
       ...
       self._load_cc_page(domain=job.target, job_id=job_id)

   def _load_cc_page(self, domain=None, job_id=None):
       job = self.jobs.get(job_id) if job_id is not None else self.jobs.active_job
       domain = job.target if domain is None else domain   # 禁止回读 entry_domain
   ```

3. **不完整提示**：每页结果回主线程后登记原因，并在状态/摘要中展示：

   ```python
   for item in result.get("incomplete_reasons") or ():
       job.add_reason(item)
   if result.get("parse_skipped"):
       job.completeness = "partial"
   ```

说明：独立验收夹具中 `test_malformed_line_has_no_incompleteness_signal`
只能证明“当时没有 `dropped_lines` / `completeness` 字段”；本批新增字段名为
`parse_skipped` / `incomplete_reasons`，该用例需由测试侧改为正向断言。
