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
src/renderer    正式界面：结果工作区、任务状态、筛选/排序/分页/复制/导出（无 Node 权限）
tests/unit      离线单元测试（Playwright Test runner）
tests/e2e       Electron 端到端（本地回环夹具，不访问外部目标）；ui-workspace.spec.ts 为界面验收
scripts         构建、清理、打包后验证；无 Python 调用
```

## 界面（正式版）

布局为五行网格（查询栏 / 查询选项 / 任务状态 / 结果工作区 / 分页导出），
只有表格区域可伸缩，**分页与导出栏是固定行，任何窗口高度和字号下都不会被挤掉**。

- 结果归属：结果头常显本次任务的 `目标 · 来源（view.source）· 主机及子域 · 范围 · 代理`，
  并带 `读取上限` 与查询时钟（tooltip）。目标、来源、时间范围、代理中任一项被修改后，
  选项栏提示“本次查询仍使用已冻结配置；X 的修改将在下次查询生效”，不改变在途请求。
- 任务状态：色块 + 文案单一来源（就绪/准备中/查询中/停止中/完成/部分完成/失败/已停止）。
  复制、导出、页码越界、代理等提示走独立的通知区，不覆盖任务文案。
  点击开始后立即进入准备态、禁用开始/停止并清零摘要；`startQuery` 失败回滚上一次终态与结果。
- 不完整原因：存在原因时结果头显示“N 项未完成”，可打开原因面板逐条查看
  （解析丢行、网络、页数上限、范围未知等）。“复制摘要”走受限 `copyReasons`
  桥（jobId/source/revision，主进程写系统剪贴板），失败/`STALE_VIEW` 不提示成功。
- 结果区：6 列（行号 + 五字段），行号在筛选集合内跨页连续；点击列头排序（稳定，
  服务端对全量筛选结果排序）；每页 20–1000、页码跳转、勾选复制 URL/整行。
  未勾选任何行时复制会提示先选择，不回退为“复制整页”；表头全选当前页保留。
  命中共享敏感路径规则的行按 `RowView.interesting` 高亮（未开启敏感筛选也高亮）。
- 筛选：状态码、文件类型、URL 关键词、域名（支持 `!` 排除，提示来自当前页）、敏感路径；
  输入与已应用条件不一致时显示“有条件未应用”。
- 请求一致性：`getView` 带请求代际与 `jobId/source` 校验，旧响应不会覆盖新视图。
- 字号：小/默认/中/大/超大，仅改变表格字号与行高，不移动固定区。
- 主题：以 `nativeTheme` 受限通道为权威（`themeGet` 初始值 + `themeChanged` 更新），
  写入 `documentElement[data-theme]` 驱动 token；`prefers-color-scheme` 仅作桥接就绪前回退。
- 空状态：未开始、查询进行中无记录、完成且确实无记录、筛选无匹配，以及
  “未取得可用记录”（部分完成/范围未知/解析丢行且 0 条，带“查看原因”入口）。

界面验收命令：

```bash
npm run build
npx playwright test --project=electron tests/e2e/ui-workspace.spec.ts
```

覆盖 1202×680 与 1040×620、五档字号下底栏可达与可见行数、状态/提示分离、
终态同帧、原因面板、筛选（含域名/敏感路径）、排序/每页/跳页/行号、字号不动固定区、
nativeTheme 切换（不从 emulateMedia 冒充）、真实剪贴板读回、前缀准备态与失败回滚、
取消终态、连续请求取最后一次、0 条原因空态、配置冻结提示与命中行高亮。

验证记录（2026-11-13，Windows 11 / Node 26.13.0）：`typecheck`、`build` 通过；
单元 **63 passed**；Electron E2E **28 passed**（`desktop.spec` 4 + `theme-contract` 2 +
`ui-workspace` 22）；打包 `dist:win` + `verify:packaged` **PACKAGED_VERIFY_OK**。
基线候选 `0859d1f` 的独立 acceptance（`75afc8f`）记录保持 **89 tests / 88 pass / 0 fail / 1 skip**，
不由本界面提交改写。

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
- 任务：单任务串行；`startQuery` 在任何 await 之前原子占用唯一任务槽，失败回滚，
  BUSY 覆盖所有未终态任务；窗口关闭期间/之后拒绝新建任务。`jobId/source/seq/revision`
  归属；终态只发一次且递增 revision，随后发同 revision 的 `viewChanged`；停止保留已收记录；
  旧任务/跨来源事件不写入新集合；`closeAll` 幂等关闭每个任务 session 并停止后续调度。
- 范围与预算：保留既有查询预算（Wayback ≤20×50、CC ≤5 页/pageSize=5）不扩大；
  额外有限资源预算：单响应 ≤8 MiB、单任务 ≤50,000 条记录、历史保留 ≤20 个终态任务；
  响应/记录超限记 `record_limit` 原因并落 `partial`，不静默丢弃。
- 网络：每任务独立 Electron session 分区，`setProxy` 完成后才请求；代理失败即失败，
  不回退直连；请求有独立 deadline，取消中止在途请求。
- 代理认证：固定代理 URL 中的 `user:pass@` 只用于内存中的每任务凭据，通过 Chromium
  代理挑战（`ClientRequest` 的 `login` 事件）按需应答，且只应答匹配该代理 host:port
  的挑战；代理规则、`ProxySnapshot`、错误文本与日志都不含凭据。SOCKS 认证 Chromium
  不支持，启动任务时明确拒绝并给出可理解原因，不会静默直连。生产代理配置保留 Chromium
  默认的 loopback bypass；环回代理成功与真实代理成功分开验证（非环回用本机非 loopback
  地址夹具）。
- 来源约束：CC 只接受官方 `https://index.commoncrawl.org` 或与配置索引同源的 `cdx-api`；
  其余端点按非法元数据计数并给 `range_unknown` 原因。

IPC 方法：`archive:startQuery`、`archive:cancelQuery`、`archive:getView`、
`archive:exportResults`、`archive:copySelection`、`archive:copyReasons`、
`archive:themeGet`，事件通道 `archive:jobEvent` 与 `archive:themeChanged`。
所有输入在 main 做运行时校验，校验发送方 `webContents` 与 `senderFrame`，统一返回
`{ok:true,value}` / `{ok:false,error}`；默认 session 显式拒绝所有权限请求。
`copyReasons` 只按 `jobId/source/revision` 取该任务原因并由主进程写剪贴板，不开放
任意 IPC 或任意文本剪贴板。`themeGet` 返回 `{schemaVersion,shouldUseDarkColors,themeSource}`，
`themeChanged` 为同一结构的推送；窗口关闭时注销 nativeTheme 监听，不提供任意事件订阅。

## 已知缺口

- SOCKS 代理认证不受支持（Chromium 无该能力）：启动时明确拒绝并提示改用 HTTP 代理
  认证或免认证 SOCKS5，不会回退直连；未用真实 SOCKS 认证服务做连通性证明。
- 生产固定代理保留 Chromium 默认 loopback bypass，因此 127.0.0.1 代理夹具不能证明
  默认配置走代理（验收脚本中该场景如实标记为 gap）；真实代理路径由非 loopback
  地址夹具验证，未改变生产 bypass 策略。
- CC 官方 `from/to` 语义按官方 collinfo 元数据实现，未联网核对真实索引样本。
- 界面在 125% 缩放的 2048×1152 屏幕上以 1202×680、1040×620 内容尺寸实测，
  未在真实 1366×768 物理显示器、100% 缩放下人工走查；macOS/Linux 未验证。
- 逐行“敏感路径高亮”已接线：`RowView.interesting` 由 domain 规则计算，界面按该标记
  着色，浅深色各有 token；未开启敏感筛选时同样高亮。
- 原因摘要复制已接线受限 `copyReasons`（主进程写系统剪贴板）；`execCommand` 假成功
  路径已移除，`STALE_VIEW`/失败/0 条均不会提示复制成功。
- 主题已接线 `themeGet`/`themeChanged`：`nativeTheme.themeSource` 切换实测页面 token
  更新；未在真实操作系统“设置”里手动切换主题，也未验证多显示器/远程桌面下的系统主题事件。
- 域名筛选的下拉提示仅来自当前页出现的域名（占位已标注“当前页”），不代表全量域名清单。
- 打包未签名；未打 NSIS/MSI；未在无 Node 的干净 Windows 机器做人工验收（本地已用
  打包后的 exe 受控启动验证）。
