# archrecon 核心层接口（首版）

本文件记录 NEPT-3 首版实现的核心接口，供后续界面改造与独立测试对接。
所有接口只依赖标准库，可直接在无 GUI 依赖的离线环境导入。

```python
import archrecon  # 包入口，导出下列全部公开名称
```

## 1. 数据模型

### `ArchiveRecord`

不可变记录，字段：`url`、`status_code`、`length`、`file_type`、`timestamp`、
`source`、`raw_timestamp`。

- `ArchiveRecord.from_mapping(mapping)`：接受既有标准化字典，也兼容
  `original` / `statuscode` / `mimetype` 等原始字段名，非字符串值自动转字符串。
- `to_export_row()`：六列导出字典，键顺序固定
  `timestamp, status_code, length, file_type, url`，不含 `#` 行号与 `source`。
- `value_of(column)`：读取任意界面列，未知列返回空串。
- `to_mapping()`：包含 `source`、`raw_timestamp` 的完整字典。

`EXPORT_COLUMNS` / `DISPLAY_COLUMNS` 为对应的列顺序常量。

### 错误

`AppError(code, message, *, source=None, retryable=False, context=None)`，
`ErrorCode` 取值：`input / network / response / parse / export / internal`。
导出失败以 `ErrorCode.EXPORT` 抛出，界面据此提示。

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
| `snapshot()` | 导出快照：当前视图全部记录（六列字典），与界面顺序一致 |
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
job = jobs.start("wayback")          # 新任务；未结束的旧任务标记为 stopped
jobs.accepts(job.job_id)             # 事件是否属于当前任务
jobs.accepts_data(job.job_id)        # 当前任务是否还能接收数据
jobs.get(job.job_id)                 # 任务对象
jobs.finish_active(JobStatus.PARTIAL, "原因")
```

`QueryJob` 字段：`job_id`、`source`、`status`、`received_count`、
`unique_count`、`completeness`、`reason`、`started_at`、`finished_at`、
`stop_event`。方法：`mark_running()`、`request_stop()`、`finish(target, reason)`、
`note_batch(received, unique_total)`、`to_dict()`。

状态：`preparing → running → stopping → completed / partial / failed / stopped`。
终态不再接收数据，也不允许再次转换。后台回调必须携带 `job_id` 并在入口处
调用 `accepts` / `accepts_data`，旧任务事件一律丢弃。

## 5. 导出

```python
write_csv(rows, path) -> int    # UTF-8 BOM，六列表头，原子替换
write_json(rows, path) -> int   # 对象数组，ensure_ascii=False，indent=2
```

`rows` 来自 `collection.snapshot()`；导出内容与筛选快照一致，不受当前页影响。
写入失败抛出 `AppError(ErrorCode.EXPORT)`，不会留下临时文件或覆盖原文件。

## 6. 已知边界

- 界面仍使用 `Widget.after` 向主线程投递事件，尚未改为有界队列；归属校验已生效。
- 停止依赖在途请求超时收敛，不保证毫秒级中断。
- 导出保持既有六列，未对 CSV 公式注入做转义（与基线输出保持一致）。
- `api_client` 的月份近似与日志时区问题不在本批范围。
