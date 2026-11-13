# 生产代码独立验收报告（PR #2 / a417955）

- 日期：2026-11-13
- 分支：`agent/agent/133403d1c75a-prod-acceptance`（从 `a417955` 建立，仅修改 `desktop/acceptance/`）
- 被测固定 SHA：`a417955`（PR #2）
- 环境：Windows 11 Pro 10.0.26300、Node **v26.13.0**、npm 11.20.0、Electron **45.3.1**、TypeScript 7.0.2、esbuild 0.28.2、electron-builder 26.18.0、Playwright 1.65.0
- 依赖：`npm ci` 按锁文件安装 290 包；Electron 二进制落盘
- 约束：未修改生产代码/锁文件/共享 contracts；未访问外部目标；未调用 Python
- 验收方式：`harness/production-entry.ts` 经 esbuild 打包后导入**真实生产模块**；无 reference/legacy 实现参与

## 1. 构建与开发自测（仅记录，不构成独立验收）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run build` | 通过（dist/main/main.js、dist/preload/preload.js、renderer） |
| `npm test`（Playwright unit） | **42 passed** |
| `npm run test:e2e`（真实 Electron） | **4 passed** |
| `npm run dist:win` | 通过，生成 `release/win-unpacked` 与 ZIP |
| `npm run verify:packaged` | 第 1 次 `expected 3 rows, got 0`，第 2 次 **PACKAGED_VERIFY_OK**（见观察项） |

本地产物：

- `release/ArchiveRecon-0.1.0-win-x64.zip`
- 大小：**153,298,746 bytes**
- SHA-256：`c226f42d4baa7544820654629c6e3bb5c4c8df140bd04d326768b96278a2af40`
- 该本地 ZIP 与已发布 Release 资产（153,298,675 bytes / `58DFCE82…F1C08C`）**不是逐字节相同**；归档时间戳/元数据会使 ZIP 哈希变化，不能用发布资产哈希替代本地构建验证。

## 2. 独立验收结果

```text
node acceptance/run-acceptance.mjs
production acceptance tests=8
tests 54 / pass 49 / fail 4 / skipped 1
exit 1
```

通过项覆盖：

- T1 合法目标、userinfo/空白/路径/查询/片段/端口/反斜杠拒绝、非法输入 0 session/0 请求、
  Wayback `matchType=domain`/collapse、CC `*.`/pageSize=5、结果域名筛选；
- T2 成功/零结果/失败/部分、BUSY、Wayback 末页与空页取消、CC 末页取消、终态幂等；
- T3 官方 `from/to` 选择（2024-10 → 2024-42，排除 2024-38/10）、最近 3 个自然月、
  异常元数据“范围未知”、`cdx-api`/原始时间保留、解析丢行计数与 `partial`；
- T4 同批/跨批去重、完整 URL 身份、筛选/排序保持、稳定排序、0-based 分页、
  五字段 snapshot、R1 清空后 view/page/snapshot 全空、新查询不泄漏旧结果；
- T5 CSV 与基线附件**逐字节相等**、JSON 结构一致、120→70 全量快照、STALE_VIEW、
  写失败无临时残留、复制当前 revision 行；
- R3 每个任务冻结自身目标，跨任务请求不串目标；
- R4 CC 停止后启动 Wayback 不触发 CC 请求、错误来源 view/cancel/export 被拒、
  事件 jobId/source 一致；
- R5 closeAll 后不再投递事件、停止后重启任务独立、代理配置校验与凭据脱敏；
- T6 夹具 17 项哈希、原始五字段样本不变、生产 package/builder 白名单、无 Python。

### 2.1 失败项（产品缺陷证据，未放宽断言）

| # | 测试 | 实测 | 期望 | 位置 |
|---|---|---|---|---|
| D1 | T1 目标校验 | `normalizeTarget("exa%6Dple.com")` 返回 `ok:true` | 拒绝百分号编码主机（非法主机表示） | `desktop/src/domain/target.ts` |
| D2 | T3 无时区官方时间 | `parseOfficialTimestamp("2024-10-03T09:40:20")` 在 `TZ=Asia/Shanghai` 下返回 `2024-10-03T01:40:20Z` | 按 UTC 解释，返回 `2024-10-03T09:40:20Z` | `desktop/src/domain/time.ts` 的 `Date.parse(value)` |
| D3 | T3 跨月选择 | 2025-05 窗口未选中 `CC-MAIN-2025-18`（其 `to=2025-05-01T01:05:29` 被本地时区后移） | 2025-05 应选中该索引 | 同上，边界偏移 |
| D4 | T3 月边界 | `from=2024-11-01T00:00:00` 的索引被误判为与 2024-10 相交 | 不相交 | 同上 |

D2–D4 同一根因：无时区后缀的官方元数据使用本地时区解析，违反 ADR-002
“无时区后缀的档案字段按 UTC 时间轴解释并保留原值”。在 UTC+8 环境下，
跨月/边界索引会漏选或多选。

### 2.2 Skip（真实状态，不删除）

`T6: packaged Windows ZIP without Node/Python is not yet verifiable` — 发布 ZIP
已存在，但没有无 Node/Python 的干净 Windows 环境；本机打包 exe 冒烟不能替代。

## 3. 真实 Electron 环回代理验收

命令：

```powershell
node acceptance/prepare.mjs
.\node_modules\electron\dist\electron.exe acceptance\proxy\generated\run-proxy-acceptance.cjs
```

结果（`PROXY_ACCEPTANCE_RESULT`）：

| 场景 | 结果 | 说明 |
|---|---|---|
| 生产配置 + 环回 HTTP 代理 | **缺口** | Chromium 默认 bypass loopback：origin 1、proxy 0；生产 `setProxy` 未设 `<-loopback>`，不能据此证明代理成功 |
| HTTP 代理（测试专用 `<-loopback>`） | PASS | proxyHits=1，响应成功 |
| HTTP 代理认证（userinfo） | **缺口/不支持** | `ERR_NO_SUPPORTED_PROXIES`，生产无代理认证处理 |
| SOCKS5 代理（测试专用 `<-loopback>`） | PASS | socksHits=1，响应成功 |
| SOCKS5 认证（userinfo） | **缺口/不支持** | `ERR_NO_SUPPORTED_PROXIES` |
| 代理连接失败（`127.0.0.1:1`） | PASS | `ERR_PROXY_CONNECTION_FAILED`，originHits=0（未直连） |

结论：固定代理失败**不直连**已验证；无认证 HTTP/SOCKS5 代理可用；代理认证未实现，
生产配置对环回目标的代理验证受 Chromium 默认 bypass 限制。认证支持属首版缺口，
需产品/ADR 明确是否支持，不能宣称已全支持。

## 4. 观察项

1. `verify:packaged` 第一次在状态变为“完成”后立即计数得到 0 行，第二次得到 3 行；
   可能是状态/行渲染时序或打包冷启动竞态。开发 E2E 使用自动重试断言，未暴露；
   建议打包验证脚本改为等待行数而非立即计数。
2. 生产 `buildProxyConfig` 接受带 userinfo 的固定代理 URL，但 Electron 返回
   `ERR_NO_SUPPORTED_PROXIES`；凭据不会出现在日志（snapshot 已脱敏），但认证功能不存在。
3. 生产 `parseCcIndex` 对没有 `id`/`cdx-api` 的条目返回 null，任务会静默忽略该条目；
   若整份 collinfo 全部缺字段，任务显示“没有可用索引”而非“元数据异常”，需 UI 批次确认提示准确性。
4. `JobManager` 每次任务保留在内存中，长时间多次查询会累积少量对象；当前非功能缺陷。
5. 全国范围 `all` 查询保留未知时间元数据索引并标 partial，符合 ADR；有限月份查询排除并计数。

## 5. 未覆盖 / 阻塞

| 项 | 状态 | 说明 |
|---|---|---|
| 无 Node/Python 干净 Windows 环境打开 ZIP | BLOCKED | 当前机器有 Node/Python；不能用本机 exe 冒烟冒充 |
| 真实外部 Wayback/CC 响应 | 未测 | 按验收要求只用夹具，不访问外部目标 |
| 真实代理认证（HTTP Basic / SOCKS auth） | 未支持 | 见第 3 节；需产品决定 |
| 1366×768/1202×680/1040×620、浅深主题、P1 交互 | 未测 | renderer 正式界面提交后进行 |
| macOS/Linux | 未验证 | 仅 Windows |
| 10,000 条性能 | 未测 | 仅 120 条导出快照 |
| 发布资产远程回读 | 未做 | 属 DevOps 发布准备；本地 ZIP 哈希已记录 |

## 6. 集成复测命令

```powershell
cd desktop
npm ci
npm run typecheck
npm run build
node acceptance/run-acceptance.mjs
node acceptance/prepare.mjs
.\node_modules\electron\dist\electron.exe acceptance\proxy\generated\run-proxy-acceptance.cjs
```

在固定集成 SHA 上重跑；D1–D4 修复前不得判定 T1/T3 通过。代理认证与干净环境 ZIP
仍为缺口，按实际结果记录，不以 skip 或源码运行替代。
