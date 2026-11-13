# Archive Recon desktop (TypeScript / Electron)

非 Python 重实现，按 `docs/../ADR-002`（提交在议题附件中）落实。目录自成一体：
不引用仓库根目录的 Python 代码、`tests/` 或 `acceptance/`，运行时不需要 Python/Node。

## 环境与版本

- 宿主工具链：Node **26.13.0**、npm **11.20.0**（Windows 10.0.26300）。
- 依赖锁定：Electron **45.3.1**、TypeScript **7.0.2**、esbuild **0.28.2**、
  electron-builder **26.18.0**、Playwright Test **1.65.0**、@types/node **24.19.2**。
- 首次安装（可联网）使用 `npm ci`；npm 的 install-scripts 需先批准 electron/esbuild
  （package.json 的 `allowScripts` 已记录）。
- 依赖/资源缓存建议放在工作区，例如 `npm_config_cache=<workspace>/.npm-cache`。

## 目录

```text
src/contracts   IPC DTO、通道名、运行时校验（版本 1）
src/domain      记录、结果集合、筛选/排序、UTC 月份与 CC 官方区间、目标校验
src/application 任务状态机、冻结配置、事件归属、导出快照
src/main        Electron 生命周期、IPC、会话/代理隔离、适配器、五字段导出
src/preload     白名单 contextBridge
src/renderer    最小可运行接线壳（正式界面由前端接管）
tests/unit      离线单元测试（Playwright Test runner）
tests/e2e       Electron 端到端（本地回环夹具，不访问外部目标）
scripts         构建、清理、打包后验证；无 Python 调用
```

## 可复现入口

```bash
npm ci
npm run typecheck
npm test          # 单元测试
npm run build
npm run test:e2e  # Electron 真实窗口 + 本地夹具
npm run dist:win  # release/win-unpacked 与 release/ArchiveRecon-<ver>-win-x64.zip
npm run verify:packaged  # 启动打包后的 exe 跑一次离线数据流

# 独立验收（队友维护的 desktop/acceptance，不改断言）
node acceptance/prepare.mjs
node acceptance/run-acceptance.mjs
node_modules/electron/dist/electron.exe acceptance/proxy/generated/run-proxy-acceptance.cjs 2>&1 | Select-String PROXY_ACCEPTANCE_RESULT

# 非环回真实代理验证（本机非 loopback 地址，生产 bypass 策略不变）
node tests/integration/run-proxy-nonloopback.mjs
```

`dist:win` 使用 `win.signAndEditExecutable=false`（未签名、不改 exe 资源），
产物为完整运行时目录的 ZIP（根目录即 `win-unpacked` 内容），不含任何 `.py`、
`.venv`、`tests/` 或 `node_modules`。

## 测试用环境变量（仅 `ARCHRECON_TEST_MODE=1` 生效）

- `ARCHRECON_WAYBACK_URL`：覆盖 Wayback CDX 端点（本地夹具）。
- `ARCHRECON_CC_INDEX_BASE`：覆盖 Common Crawl 索引基址（夹具的 collinfo 需返回本地 cdx-api）。
- `ARCHRECON_EXPORT_DIR`：导出不再弹保存对话框，直接写入该目录（自动化用）。

生产运行不读取这些变量；真实端点为官方默认值。

## 行为契约（摘要）

- 目标：主机及其子域；`*.example.com` 是输入别名；拒绝路径/参数/片段/端口/用户信息/内部空白。
- 预算：Wayback ≤20 页 × 50 条；CC 每索引 ≤5 页、`pageSize=5`（索引块单位）。
- 时间：自然月 UTC `[月初, 下月初)`；时钟在任务开始时冻结；CC 仅按官方
  `cdx-api` + `from/to` 区间相交选择，绝不从索引 ID 推断月份。官方 `from/to`
  无论是否带时区后缀都按 UTC 严格解析（带 `Z`/偏移量时尊重偏移），保留原值；
  缺失、非法、倒置（from > to）一律标为“范围未知”，有限月份查询排除并记录原因。
- 目标校验在任何 URL 解析/网络调用之前完成：拒绝路径、参数、片段、端口、用户信息、
  内部空白、百分号编码主机、反斜杠与控制字符；`*.example.com` 只是输入别名。
- 结果：按原始完整 URL 首条去重；筛选作用于全部集合；追加保持筛选/排序；
  排序稳定；导出使用当前筛选排序的全量不可变快照。
- 导出：五字段 `timestamp,status_code,length,file_type,url`，CSV UTF-8 BOM + CRLF，
  JSON UTF-8 数组；内部 source/rawTimestamp/indexId 与行号不导出；同目录临时文件 + rename。
- 任务：单任务串行；`jobId/source/seq/revision` 归属；终态只发一次；停止保留已收记录；
  旧任务/跨来源事件不写入新集合；窗口关闭先取消并停止后续调度。
- 网络：每任务独立 Electron session 分区，`setProxy` 完成后才请求；代理失败即失败，
  不回退直连；请求有独立 deadline，取消中止在途请求。
- 代理认证：固定代理 URL 中的 `user:pass@` 只用于内存中的每任务凭据，通过 Chromium
  代理挑战（`ClientRequest` 的 `login` 事件）按需应答；代理规则、`ProxySnapshot`、
  错误文本与日志都不含凭据。SOCKS 认证 Chromium 不支持，启动任务时明确拒绝并给出
  可理解原因，不会静默直连。生产代理配置保留 Chromium 默认的 loopback bypass；
  环回代理成功与真实代理成功分开验证（非环回用本机非 loopback 地址夹具）。

IPC 方法：`archive:startQuery`、`archive:cancelQuery`、`archive:getView`、
`archive:exportResults`、`archive:copySelection`，事件通道 `archive:jobEvent`。
所有输入在 main 做运行时校验，统一返回 `{ok:true,value}` / `{ok:false,error}`。

## 已知缺口

- SOCKS 代理认证不受支持（Chromium 无该能力）：启动时明确拒绝并提示改用 HTTP 代理
  认证或免认证 SOCKS5，不会回退直连；未用真实 SOCKS 认证服务做连通性证明。
- 生产固定代理保留 Chromium 默认 loopback bypass，因此 127.0.0.1 代理夹具不能证明
  默认配置走代理（验收脚本中该场景如实标记为 gap）；真实代理路径由非 loopback
  地址夹具验证，未改变生产 bypass 策略。
- CC 官方 `from/to` 语义按官方 collinfo 元数据实现，未联网核对真实索引样本。
- 真实 1366×768/1202×680/1040×620 桌面、浅深主题、P1 界面交互属前端后续工作。
- 打包未签名；未打 NSIS/MSI；未在无 Node 的干净 Windows 机器做人工验收（本地已用
  打包后的 exe 受控启动验证）。
