# 生产代码独立验收报告（第二轮，基础 `e88f864` / 被测 `a417955`）

- 日期：2026-11-13
- 分支：`agent/agent/133403d1c75a-prod-acceptance`（基础 `e88f864`，本轮仅改 `desktop/acceptance/`）
- 被测固定 SHA：`a417955`（PR #2）
- 环境：Windows 11 26300、Node 26.13.0、npm 11.20.0、Electron 45.3.1、Playwright 1.65.0
- 未修改生产代码/共享 package/lock/contracts；未访问外部目标；未调用 Python
- 本轮针对审查新增：并发 start/双击、创建期关闭、closeAll 会话、Wayback 原始行数续页、非法主机矩阵、非法日期回卷、10k 计时、独立打包验收

## 1. 结果

```text
node acceptance/run-acceptance.mjs
production acceptance tests=9
tests 89 / pass 68 / fail 20 / skipped 1
exit 1
```

失败按缺陷组归类（Node 计数含子用例）：

| 组 | 数量 | 实测 | 期望 |
|---|---:|---|---|
| T1 非法主机字符 | 9 子用例 | `*.*.example.com`、`foo.*.example.com`、`*example.com`、`example.com*`、`exa*mple.com`、`example.com\foo`、`foo_bar.example.com`、`exa%6Dple.com`、`exa%20mple.com` 均 `ok:true` | `INVALID_INPUT`，0 网络调用 |
| R6 并发/会话 | 5 | 并发与双击均返回两个 `ok:true`、创建 2 个 session、发出 2 组请求；create 挂起时 closeAll 后仍启动并请求；closeAll 后 `sessions.close` 为空；closeAll 后仍可 start | 第二次 BUSY；仅 1 session/1 请求组；关闭后不发请求、关闭每个 session、拒绝新任务 |
| T3 UTC 元数据 | 3 | 无时区 ISO 按本地时间解析；2025-05 漏选 `CC-MAIN-2025-18`；`2024-11-01T00:00:00` 误判与 2024-10 相交 | 按 UTC 解析；跨月/边界选择正确 |
| T3 Wayback 续页 | 1 | 50 原始行含 1 坏行 → 49 条解析、`hasMore=false`，只请求 page 0，unique=49 | 用原始 50 行判续页，请求 page 1，unique=51 |
| T3 非法日期 | 1 | `2024-02-30T00:00:00`、`20240230000000`、`2024-04-31T12:00:00` 被 Date 回卷（如 3 月 1 日），`unknown=false` | 判 `unknown=true`，`fromMs=null`，不伪称有效范围 |

通过的关键项：

- 五字段 CSV 与原始样本逐字节一致；JSON 结构/UTF-8 一致；内部字段不导出；
- 解析丢行 `parse_line count=1` 有原因；官方元数据相交（非 UTC 边界）与异常元数据“范围未知”；
- 取消末页/空页/CC 末页 → 唯一终态 stopped；停止重启任务独立；错误来源 view/cancel/export 被拒；
- 代理配置校验、凭据脱敏；真实 Electron 代理失败不直连（见上一轮代理结果，仍适用）；
- 独立打包验收 **PACKAGED_ACCEPTANCE_RESULT ok=true**：精确终态“完成”、重试行数 3、CSV 五字段/BOM。

## 2. 10,000 条性能实测

| 操作 | 实测 |
|---|---|
| 10k 记录 filter(status=200, 5000 条) + sort(length desc) + page(100) + snapshot | 2.3 / 1.0 / 2.5 ms（三次），worst 2.5 ms |
| 10k → 5000 行 CSV 快照（330,941 bytes） | 13.7 ms |

均远低于 ADR 的 2s 目标。该结果只覆盖 domain 纯函数/集合层；真实 renderer 渲染未测。

## 3. 响应/记录预算缺口（未实现）

审查与代码核对一致，当前生产代码**没有**响应字节上限、记录数上限或 `record_limit` 产出：

- `desktop/src/main/adapters/http.ts` 先读取完整 body，无字节上限；
- `desktop/src/application/job.ts` 只在页数/`pageSize` 预算内循环，没有记录预算；
- `RecordLimit` 原因码存在但从未产生；`FrozenJobConfig.budget` 只有 `maxPages/pageSize`；
- 大页 JSON/NDJSON 在主进程同步解析，存在窗口阻塞/内存上涨风险。

因此“达到记录/响应预算显示 partial 及原因”仍为未实现项；本轮只记录，不伪称通过。

## 4. 打包验收（独立脚本）

```text
node acceptance/packaged/run-packaged-acceptance.mjs
PACKAGED_ACCEPTANCE_RESULT {"ok":true,"title":"Archive Recon","status":"完成","rows":3,"csvFile":"…-wayback_results.csv","csvBytes":210}
```

- 等待 `status-chip` **精确等于“完成”**，不会匹配“部分完成”；
- 行数断言可重试（20s），修复了开发 `verify:packaged` 在状态到达后立即计数的竞态；
- 导出 CSV 验证 BOM、五字段表头、3 条记录。
- 开发 `verify:packaged` 首次仍可出现 0 行（同一竞态）；本轮独立脚本不受影响。
- 无 Node/Python 干净 Windows 环境的 ZIP 验收仍为 **skip**（真实缺口）。

### 4.1 打包 exe 真实双击

```text
node acceptance/packaged/run-double-click-acceptance.mjs
DOUBLE_CLICK_ACCEPTANCE_RESULT {"ok":false,"waybackHits":2,"expected":1,"detail":"double click created multiple request groups"}
```

在真实打包窗口中对开始按钮双击，夹具收到 **2 次** `/wayback` 请求，验证应用层并发
缺陷（R6）在真实 UI 路径同样存在；修复后应只有 1 次请求组。

## 5. 构建

- `npm ci`：290 包；Electron 45.3.1 二进制可用
- `npm run typecheck`：通过
- `npm run build`：通过
- `npm run dist:win`：通过；本地 ZIP 153,298,746 bytes，SHA-256 `c226f42d…a2af40`
- 开发自测：unit 42 pass；Electron E2E 4 pass（仅记录，不作为独立验收）

## 6. 未覆盖 / 阻塞

- 无 Node/Python 干净 Windows 环境 ZIP 验收；
- 生产配置下环回代理默认 bypass；HTTP/SOCKS 代理认证未实现（见上一轮报告）；
- 真实外部来源响应、renderer 正式界面小窗口/主题/P1、macOS/Linux；
- 10k 真实 UI 渲染与响应体预算（只测了 domain 集合层）；
- 终态 revision、`page_limit` 原因准确性、非法元数据 unknown 计数、`cdx-api` 来源约束、IPC senderFrame/关闭期校验等审查项未在本轮验收范围内新增测试（建议下一批修复后用同一 harness 复核）。

## 7. 复测命令

```powershell
cd desktop
npm ci
npm run typecheck
npm run build
node acceptance/run-acceptance.mjs
node acceptance/prepare.mjs
.\node_modules\electron\dist\electron.exe acceptance\proxy\generated\run-proxy-acceptance.cjs
node acceptance/packaged/run-packaged-acceptance.mjs
```

**结论：`a417955` 仍不能验收通过。** 新增 5 组缺陷（并发/会话、Wayback 续页、非法日期、非法主机扩展、UTC 边界）均有可复现失败；修复版返回后按本文同一断言复测，不放宽断言。
