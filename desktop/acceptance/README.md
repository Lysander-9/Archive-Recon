# 独立验收（TypeScript / Electron，生产代码版）

本目录是 NEPT-3 非 Python 重开发的独立验收套件，验收固定提交
**`a417955`**（PR #2，Electron 45.3.1 / TypeScript 7.0.2 / esbuild 0.28.2 /
electron-builder 26.18.0 / Playwright 1.65.0）。

- 只修改 `desktop/acceptance/`；不修改共享 package/lock/contracts 或生产代码。
- 测试通过 `harness/production-entry.ts` 引入**真实生产模块**，不导入任何
  reference/legacy 参考实现。
- 不调用 Python，不访问外部目标；来源响应全部来自内存夹具。
- 测试运行器使用 Node 26.13.0 内置 `node:test`；生产源码由 esbuild 打包成
  ESM 供测试导入（Node 类型剥离不支持 JobManager 的 TypeScript 参数属性）。

## 前置

```powershell
cd desktop
npm ci                 # 290 包；Electron 45.3.1 与 esbuild 0.28.2 二进制
npm run typecheck      # 生产类型检查
npm run build          # 产物 dist/
```

## 运行独立验收

```powershell
# 生产模块验收（自动打包 harness/production-entry.ts 后运行）
node acceptance/run-acceptance.mjs

# 构建 Electron 代理验收脚本并运行（真实 session.fetch + 环回代理）
node acceptance/prepare.mjs
.\node_modules\electron\dist\electron.exe acceptance\proxy\generated\run-proxy-acceptance.cjs
```

当前基线结果（2026-11-13，提交 `a417955`）：

| 项 | 结果 |
|---|---|
| 独立验收 | **54 tests / 49 pass / 4 fail / 1 skip**，exit 1 |
| 失败 | T1 百分号编码主机 1 项；T3 UTC 元数据 3 项 |
| skip | 无 Node/Python 干净 Windows 环境的 ZIP 验收（真实缺口，不删除） |
| 开发自测（仅记录） | unit 42 pass；Electron E2E 4 pass |
| 构建 | typecheck 通过；build 通过；`dist:win` 产出 win-unpacked + ZIP |

4 个失败是生产代码缺陷证据，不得通过修改断言消除：

1. `normalizeTarget("exa%6Dple.com")` 被接受（非法主机表示未拒绝）。
2. `parseOfficialTimestamp` 对无时区后缀的官方时间使用本地时间而非 UTC。
3. 上述 UTC 偏差使跨月/边界索引选择错误（2025-05 漏选 2025-18；
   `2024-11-01T00:00:00` 被误判为与 2024-10 相交）。

## 目录

| 路径 | 作用 |
|---|---|
| `harness/production-entry.ts` | 导出真实 contracts/domain/application/adapters/export/proxy 模块 |
| `harness/production-helpers.ts` | 生产 JobManager + 真实适配器 + 内存 Transport |
| `harness/fixtures.ts` | 夹具路径与 SHA-256 清单 |
| `harness/test-utils.ts` | 固定时钟、临时目录、基线记录 |
| `tests/t1-target.test.ts` | T1 目标校验、零会话、请求范围、域名筛选 |
| `tests/t2-lifecycle.test.ts` | 成功/零结果/失败/部分、BUSY、末页/空页/CC 取消终态 |
| `tests/t3-time-metadata.test.ts` | 官方 from/to 相交、跨月、最近 N 月、异常元数据、UTC、丢行计数 |
| `tests/t4-results.test.ts` | 去重、筛选/排序、分页、R1 缓存失效、新查询隔离 |
| `tests/t5-export.test.ts` | 五字段字节样本、120→70 快照、STALE_VIEW、写失败、复制 |
| `tests/r3-r4-isolation.test.ts` | 目标冻结、CC→Wayback 隔离、错误来源拒绝、事件来源 |
| `tests/r5-close-proxy.test.ts` | closeAll/停止重启、代理配置与脱敏 |
| `tests/t6-packaging.test.ts` | 夹具哈希、无 Python、生产 package/builder 白名单 |
| `proxy/run-proxy-acceptance.ts` | 真实 Electron session 的环回 HTTP/SOCKS/认证/失败验收 |
| `fixtures/` | 官方 collinfo、异常元数据、来源响应、固定时钟、代理矩阵 |
| `reports/` | 实际执行结果、缺陷与未覆盖项 |

## 代理验收实测（真实 Electron）

生产配置对环回目标默认绕过代理，因此：

- **生产配置 + 环回**：origin 命中 1、proxy 命中 0 → 该场景不能证明代理成功，
  列为测试环境缺口（Chromium 默认 bypass loopback；生产未设 `<-loopback>`）。
- 测试仅在 `proxy/run-proxy-acceptance.ts` 内对隔离 session 追加
  `proxyBypassRules: "<-loopback>"` 以验证协议路径；这是测试专用 override，
  不冒充生产配置：
  - HTTP 代理：成功（proxyHits=1）；
  - SOCKS5 代理：成功（socksHits=1）；
  - HTTP/SOCKS5 认证：`ERR_NO_SUPPORTED_PROXIES`，生产未实现代理认证 → 缺口；
  - 代理连接失败：`ERR_PROXY_CONNECTION_FAILED`，originHits=0（不直连）→ 通过。

## 断言口径

- CSV 与 `fixtures/export/reference-baseline-sample.csv` **逐字节相等**
  （BOM/CRLF/五字段顺序）；JSON 结构、键顺序、UTF-8 与基线一致。
- 内部 `source/rawTimestamp/indexId/rowId` 与行号不导出。
- 时间只用固定时钟；官方元数据缺失/非法/倒置标“范围未知”，不退回索引 ID 公式。
- 关闭后不得再投递 UI 事件；旧任务/跨来源事件不得写入其他任务。
- 两个 packaging 状态保持真实：生产 package/builder 已断言；无 Node/Python
  干净环境的 ZIP 仍是 skip，直到真实环境可用。

## 集成复测

在固定集成 SHA 上：`npm ci && npm run typecheck && npm run build && node acceptance/run-acceptance.mjs`。
失败项按产品缺陷处理；不得删除/放宽断言。代理脚本单独运行并记录 JSON 结果。
