# PR #1 独立验收工具（固定提交 6349a0e）

本目录针对 PR #1（`NEPT-3 首批实现：结果集合、任务事件归属与快照导出`）的固定
提交 `6349a0ea3970ab7e5d487aadaace73d22fd7b9cc`，使用 `archrecon` 核心包与 PR #1
版本的 `main.py` 验证 T1–T6 的离线可测部分。

它独立于开发方在 PR 中添加的 `tests/test_*.py`：断言来自基线实测契约与
`acceptance/ACCEPTANCE_CHECKLIST.md`，不以开发自测定义兼容性。

## 运行

在 PR #1 检出（或本仓库已包含 `archrecon` 的分支）中，于仓库根目录执行：

```powershell
uv venv .venv-pr1
uv pip install --python .venv-pr1\Scripts\python.exe -r requirements.txt

# 直接在本目录所在仓库运行（当前分支必须包含 archrecon）
.venv-pr1\Scripts\python.exe -m unittest discover -s acceptance_pr1 -v
```

若本目录位于另一个检出（例如基线分支）而目标是 PR #1 的独立解压目录，用
`ARCHRECON_ROOT` 指向被测根目录：

```powershell
$env:ARCHRECON_ROOT = "C:\path\to\pr1-6349a0e"
.venv-pr1\Scripts\python.exe -m unittest discover -s acceptance_pr1 -v
```

`ARCHRECON_ROOT` 必须在导入测试模块前生效；测试会把该目录放到 `sys.path`
最前，从而导入被测的 `main.py` / `archrecon` / `api_client.py`。

## 预期结果（2026-11-13，提交 6349a0e）

- 63 个测试，13 个失败：12 个是 T1 的 userinfo / 内部空白未被拒绝，
  1 个是 T2 的 Common Crawl 任务在索引之间重新读取输入框；
- 其余 50 个通过，包括五字段导出逐字节对照、任务归属、停止、增量去重、
  筛选保持、部分失败/截断状态、时间范围公式与打包检查。

这些失败是 PR #1 的待修复项，不是环境问题。重构/修正提交返回后应重新运行本目录，
并对照 `acceptance/PR1_ACCEPTANCE_REPORT.md`。

## 离线约束

- 所有 HTTP 在 `ArchiveAPIClient._request_with_retry` 边界替换，夹具全部为合成数据；
- 不访问 Wayback Machine、Common Crawl 或任何外部目标；
- GUI 冒烟由 `acceptance/startup_smoke.py` 单独执行（需桌面会话）。
