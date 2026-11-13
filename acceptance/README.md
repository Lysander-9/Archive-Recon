# NEPT-3 独立验收资产

本目录是测试验证 Agent 为 NEPT-3（Archive-Recon 重开发）准备的独立验收材料。
它不修改业务代码，也不修改仓库既有 `tests/`。

## 内容

| 路径 | 作用 |
|---|---|
| `ACCEPTANCE_CHECKLIST.md` | T1–T6 验收契约、基线状态、缺陷/未覆盖项 |
| `BASELINE_REPORT.md` | 基线启动/测试证据、实测契约、缺陷清单、阻塞项 |
| `fixtures/` | 合成响应夹具（Wayback CDX、CC NDJSON、collinfo、showNumPages）及来源说明 |
| `support.py` | 离线测试辅助：假传输、无 Tk 的表格/应用状态对象 |
| `test_t1_domain_contract.py` | 目标校验、两来源查询范围、结果域名筛选 |
| `test_t2_query_lifecycle.py` | 解析/分页/上限/停止/有界重试/旧任务守卫 |
| `test_t3_period_and_completeness.py` | 时间范围公式、服务端页数、部分失败/截断 |
| `test_t4_result_workspace.py` | 去重、筛选保持、清除、分页重置、排序 |
| `test_t5_export_contract.py` | 真实落盘的 CSV/JSON 五字段与失败路径 |
| `test_t6_startup_contract.py` | 导入入口、显示列、依赖声明 |
| `startup_smoke.py` | 需要桌面会话的 GUI 启动冒烟 |

## 环境与命令（Windows 优先）

```powershell
uv venv .venv
uv pip install --python .venv\Scripts\python.exe -r requirements.txt

# 既有测试（基线 12 个全绿）
.venv\Scripts\python.exe -m unittest discover -s tests -v

# 本验收套件（离线；无外部网络）
.venv\Scripts\python.exe -m unittest discover -s acceptance -v

# GUI 启动冒烟（真实窗口，1.2 秒后自动关闭）
.venv\Scripts\python.exe acceptance\startup_smoke.py --hold-ms 1200
```

基线预期结果：`Ran 67 tests ... FAILED (failures=14)`。14 个失败集中在
T1（userinfo、内部空白）与 T4（增量去重、筛选保持），是重构必须修复的项；
其余用例应保持通过。若失败数与 `BASELINE_REPORT.md` 不一致，先排查环境，
不要把环境异常当成业务通过或失败。

## 离线原则

- 所有 HTTP 调用都在 `ArchiveAPIClient._request_with_retry` 边界被替换，
  不访问 Wayback Machine、Common Crawl 或任何外部目标。
- 夹具为合成数据，不是线上抓取；不能据此宣称来源覆盖完整。
- GUI 冒烟只验证窗口可创建/销毁，不执行真实查询。

## 对重构版本执行验收

1. 在干净 venv 中运行 `tests/` 与 `acceptance/`，保存完整输出。
2. 对照 `ACCEPTANCE_CHECKLIST.md`：T1–T6 的 P0 项必须 PASS，或由需求方书面
   接受剩余风险；`BLOCKED`/`NOT RUN` 项需补人工 GUI 或来源契约证据。
3. `acceptance/` 中的断言是契约，不是开发自测的镜像。重构若改变接口，
   只允许调整 `support.py` 的适配层或测试调用方式，并在提交说明中记录；
   不得删除断言、放宽预期或跳过失败用例来获得绿灯。
4. 导出兼容以基线实际输出为准：`timestamp,status_code,length,file_type,url`
   五字段、CSV UTF-8 BOM、JSON UTF-8 数组；内部 `source` 与行号不导出。
5. 基线缺陷 D1–D14 见 `BASELINE_REPORT.md`，验收报告需逐项给出修复/未修复结论。
