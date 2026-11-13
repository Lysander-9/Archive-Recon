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

# 独立打包验收（先 npm run dist:win；精确等待“完成”再重试行数）
node acceptance/packaged/run-packaged-acceptance.mjs
```

当前基线结果（2026-11-13，提交 `a417955`，第二轮新增回归）：

| 项 | 结果 |
|---|---|
| 独立验收 | **89 tests / 68 pass / 20 fail / 1 skip**，exit 1 |
| 失败组 | T1 非法主机字符（9 个子用例）；R6 并发/会话 5 项；T3 UTC 3 项；Wayback 坏行续页 1 项；非法日期回卷 1 项 |
| skip | 无 Node/Python 干净 Windows 环境的 ZIP 验收（真实缺口，不删除） |
| 开发自测（仅记录） | unit 42 pass；Electron E2E 4 pass |
| 构建 | typecheck 通过；build 通过；`dist:win` 产出 win-unpacked + ZIP |
| 独立打包验收 | `node acceptance/packaged/run-packaged-acceptance.mjs` → **PACKAGED_ACCEPTANCE_RESULT ok=true**（精确“完成”、重试行数 3、CSV 五字段/BOM） |

失败是生产代码缺陷证据，不得通过修改断言消除：

1. `normalizeTarget` 接受 `*.*.example.com`、内嵌 `*`、反斜杠、下划线、百分号编码等非法主机；
2. 并发 `startQuery`/双击在 `sessions.create` await 前未原子占用槽位 → 两个 job/session/请求组；
3. `sessions.create` 未完成时 `closeAll` 不阻止后续启动；`closeAll` 不调用 `session.close`；关闭后仍可启动新查询；
4. `parseOfficialTimestamp` 对无时区官方时间使用本地时区；跨月/边界选择错误；
5. 非法日期（`2024-02-30`、`20240230000000`、`2024-04-31`）被 Date 回卷而非判 unknown；
6. Wayback 满页 50 原始行含 1 坏行时，用清洗后 49 行判断 `hasMore=false`，提前停止，漏掉下一页。

## 目录

| 路径 | 作用 |
|---|---|
| `harness/production-entry.ts` | 导出真实 contracts/domain/application/adapters/export/proxy 模块 |
| `harness/production-helpers.ts` | 生产 JobManager + 真实适配器 + 内存 Transport |
| `harness/fixtures.ts` | 夹具路径与 SHA-256 清单 |
| `harness/test-utils.ts` | 固定时钟、临时目录、基线记录 |
| `tests/t1-target.test.ts` | T1 目标校验、零会话、请求范围、域名筛选 |
| `tests/t2-lifecycle.test.ts` | 成功/零结果/失败/部分、BUSY、末页/空页/CC 取消终态 |
| `tests/t3-time-metadata.test.ts` | 官方 from/to 相交、跨月、最近 N 月、异常元数据、UTC、非法日期、丢行计数 |
| `tests/t3-wayback-continuation.test.ts` | Wayback 满页含坏行仍使用原始行数续页 |
| `tests/t4-results.test.ts` | 去重、筛选/排序、分页、R1 缓存失效、新查询隔离 |
| `tests/t4-perf-10k.test.ts` | 1 万条筛选/排序/分页与五字段快照计时 |
| `tests/t5-export.test.ts` | 五字段字节样本、120→70 快照、STALE_VIEW、写失败、复制 |
| `tests/r3-r4-isolation.test.ts` | 目标冻结、CC→Wayback 隔离、错误来源拒绝、事件来源 |
| `tests/r5-close-proxy.test.ts` | closeAll/停止重启、代理配置与脱敏 |
| `tests/r6-concurrency-sessions.test.ts` | 并发/双击单任务、创建期关闭、closeAll 会话清理、关闭后拒绝启动 |
| `tests/t6-packaging.test.ts` | 夹具哈希、无 Python、生产 package/builder 白名单 |
| `proxy/run-proxy-acceptance.ts` | 真实 Electron session 的环回 HTTP/SOCKS/认证/失败验收 |
| `packaged/run-packaged-acceptance.mjs` | 独立打包验收：精确“完成”+ 可重试行数 + 五字段 CSV |
| `packaged/run-double-click-acceptance.mjs` | 打包 exe 真实双击：只允许一个请求组 |
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
