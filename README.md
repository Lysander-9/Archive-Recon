# Archive Recon

面向目标域名的历史 URL 检索与整理桌面工具：同时查询 **Wayback Machine CDX** 与 **Common Crawl 索引**，把结果整理成可筛选、可排序、可导出的唯一 URL 清单。用于渗透测试前期信息收集与历史资产梳理。

当前产品为 **TypeScript / Electron 桌面应用（Windows x64）**，运行时不依赖 Python、Node 或浏览器运行时。

> 旧版 Python + Tkinter 实现已停止维护，自本次发布起由 Electron 版取代。旧源码完整保留在 Git 历史与备份分支 `backup/main-pre-ts-electron-20261113` 中，旧设计文档归档在 `docs/archive/superpowers/`。

## 下载与运行（使用者）

> 当前集成候选（PR #2）**尚未发布**。Releases 上已有的 `0.1.0` 资产属于早期构建，其 SHA/链接不代表当前候选；最终 ZIP 哈希以集成验收后发布的记录为准。

1. 打开 [Releases](https://github.com/Lysander-9/Archive-Recon/releases) 页面，下载 `ArchiveRecon-<版本>-win-x64.zip`。
2. 解压到任意本地目录。**必须保留整个目录**（`resources/`、`locales/` 与 `Archive Recon.exe` 需在同一目录），不能只复制 exe。
3. 双击运行 `Archive Recon.exe`。

- 支持：Windows 10 / 11 x64。macOS / Linux 未构建、未验证，不作支持承诺。
- 未做代码签名，Windows SmartScreen 可能提示“未知发布者”；请用发布记录中的 SHA-256 校验文件。
- 首次启动会创建用户数据目录（Electron 默认位置），不写入安装目录。

校验下载文件（PowerShell，哈希以实际发布记录为准）：

```powershell
Get-FileHash .\ArchiveRecon-0.1.0-win-x64.zip -Algorithm SHA256
```

## 功能

- **两个来源**：Wayback Machine CDX API 与 Common Crawl 索引（官方 `collinfo.json` + `cdx-api`）。
- **匹配范围**：查询目标主机及其全部子域；`*.example.com` 是输入别名，与裸域等价。范围说明会在界面显示，不承诺完整收录。
- **目标校验**：拒绝路径、查询串、片段、端口、用户信息、内部空白、百分号编码、反斜杠、控制字符、额外通配符、下划线及非法标签；任何非法输入都在创建会话/发起网络请求之前被拒绝。
- **时间范围**：最近 N 个自然月、指定年月、全部时间。自然月按 UTC `[月初, 下月初)` 计算，时钟在任务开始时冻结；Common Crawl 只按官方 `from/to` 区间相交选择已发布索引，不从索引 ID 推断月份。官方无时区时间按 UTC 严格解析（显式 `Z`/偏移量则尊重偏移），非法、回卷或倒置元数据明确标注“范围未知”并计入原因。
- **结果整理**：按完整 URL 首条去重（同批与跨批），筛选作用于全部结果并保持追加时的筛选与排序，排序稳定，分页与筛选条件一致；`RowView.interesting` 由共享规则提供，供界面高亮敏感路径。
- **导出**：CSV / JSON，固定五字段 `timestamp,status_code,length,file_type,url`，始终导出当前筛选排序下的全量快照；CSV 为 UTF-8 BOM + CRLF；内部 `source`/`rawTimestamp`/`indexId` 与界面行号不导出；同目录临时文件 + rename 原子写入。
- **任务语义**：单任务串行；启动在任何异步等待前原子占用唯一任务槽，忙时返回 BUSY，关闭窗口期间/之后拒绝新任务；`jobId/source/seq/revision` 归属校验；每个任务只发一次终态并递增 revision；停止保留已收记录；旧任务与跨来源事件不会写入新集合；关闭时幂等关闭每个任务 session。
- **网络与代理**：直连 / 系统代理 / 固定代理（HTTP、HTTPS、SOCKS）。每个任务独立 Electron session 分区，`setProxy` 完成后才发起请求；HTTP 代理认证通过 Chromium 代理挑战按任务应答，凭据只存内存且不进入规则、快照、日志或错误文本；代理失败即失败，**不静默回退直连**。SOCKS 认证 Chromium 不支持，启动时明确拒绝并说明替代方案。
- **来源端点约束**：Common Crawl 只接受官方 `https://index.commoncrawl.org` 或配置索引同源的 `cdx-api`，其他端点按非法元数据计入原因。
- **查询预算（未扩大）**：Wayback ≤ 20 页 × 50 条；Common Crawl 每索引 ≤ 5 页、`pageSize=5`（索引块单位）。达到上限时明确标记为部分结果并给出原因。
- **资源预算**：单响应 ≤ 8 MiB、单任务 ≤ 50,000 条去重记录、历史保留 ≤ 20 个终态任务；超限保留已接收数据，标记 `partial` 并给出 `record_limit`/`range_unknown` 等可见原因。

## 从源码构建（开发者）

前置：Windows x64、Node **26.13.0**、npm **11.20.0**（见 `desktop/package.json` 的 `engines`）。依赖版本已锁定：Electron 45.3.1、TypeScript 7.0.2、esbuild 0.28.2、electron-builder 26.18.0、Playwright Test 1.65.0。

```powershell
cd desktop
npm ci                    # 按 package-lock.json 安装；electron/esbuild 安装脚本已在 allowScripts 中批准
npm run typecheck
npm test                  # 单元测试（Playwright Test runner，离线）
npm run build
npm run test:e2e          # Electron 真实窗口 + 本地环回夹具，不访问外部目标
npm run dist:win          # 产出 desktop/release/win-unpacked 与 ArchiveRecon-<ver>-win-x64.zip
npm run verify:packaged   # 用打包后的 exe 跑一次离线数据流，输出 PACKAGED_VERIFY_OK
```

Windows 用户也可在仓库根目录双击 `start.bat`：它只在本地已存在 `desktop\release\win-unpacked\Archive Recon.exe` 时启动该产物，否则打印下载/构建指引（不会回退到任何 Python 入口）。

首次安装需要联网；构建产物与 `node_modules` 均不入库（见 `.gitignore`）。

当前候选验证（Windows 11 / Node 26.13.0，2026-11-13）：`typecheck`、`build` 通过；单元 **63 passed**；Electron 真实窗口 E2E **18 passed**；独立 acceptance（`75afc8f`）**89 tests / 88 pass / 0 fail / 1 skip**。最终 ZIP 与干净 Windows 分发验证在集成冻结后单独记录。

## 目录结构

```text
desktop/
  package.json / package-lock.json   锁定的工具链与构建脚本
  electron-builder.json              打包配置（zip 目标、asar、files 白名单）
  src/contracts                      版本化 IPC DTO、通道名、运行时校验
  src/domain                         目标校验、UTC 月份、CC 官方区间、结果集合/筛选/排序
  src/application                    任务状态机、冻结配置、事件归属、导出快照
  src/main                           Electron 生命周期、IPC 处理、session 代理隔离、适配器、五字段导出
  src/preload                        白名单 contextBridge
  src/renderer                       界面（HTML/CSS/JS，经 preload 白名单访问主进程能力）
  tests/unit                         离线单元测试
  tests/e2e                          Electron 端到端（本地环回夹具）
  scripts                            构建、清理、打包后验证
docs/archive/superpowers/            旧 Python 版设计与计划文档（仅历史参考）
```

IPC 面：`archive:startQuery`、`archive:cancelQuery`、`archive:getView`、`archive:exportResults`、`archive:copySelection`、`archive:copyReasons`、`archive:themeGet`，事件通道 `archive:jobEvent` 与 `archive:themeChanged`。所有入参在 main 进程做运行时校验（含发送方 `webContents`/`senderFrame`），统一返回 `{ok:true,value}` / `{ok:false,error}`；权限请求显式拒绝；主题只提供有效浅/深值与更新事件，关闭窗口时注销监听。

## 已知限制

- 仅 Windows x64 构建；未签名、无安装器（NSIS/MSI），以目录 ZIP 分发；exe 已写产品身份与图标，但仍为未签名状态。
- 固定代理支持免认证 HTTP/HTTPS/SOCKS5 与 HTTP 认证；**SOCKS 认证经确认不受 Chromium 支持，启动时明确拒绝**。真实代理路径已用非环回地址夹具验证，环回默认 bypass 缺口仍如实记录，生产 bypass 策略未改。
- Common Crawl 时间语义按官方 `from/to` 元数据实现，未联网核对全部历史索引样本。
- 界面已接入正式结果工作区；逐行 `interesting` 高亮、原因摘要复制桥、`nativeTheme` 主题契约已冻结，前端最小接线尚未完成。
- 无 Node/Python 的干净 Windows 分发验证尚未完成，现有本机打包 exe 冒烟不计为该验收。
- 旧 Python 版本的行为兼容仅限五字段导出契约；其余交互以本版本为准。

## 历史版本

| 版本 | 说明 |
|---|---|
| 0.1.0（当前） | TypeScript / Electron 重写，Windows x64 ZIP，未签名 |
| Python 版（已停止维护） | 旧 `main.py` + CustomTkinter 实现；源码见 Git 历史与 `backup/main-pre-ts-electron-20261113` |
