# 独立验收 — 固定候选 `0859d1f`

- 日期：2026-11-13
- 分支：`agent/agent/133403d1c75a-prod-acceptance-0859d1f`（从 `0859d1f` 建立）
- 验收集：`5681a83`（`75afc8f` 89 项 + R7 预算/端点/复制 6 项）
- 环境：Windows 11 26300、Node 26.13.0、Electron 45.3.1、Playwright 1.65.0
- 仅修改 `desktop/acceptance/`；未改生产/共享文件；未使用 reference；未调用 Python
- 本记录与 `2c2438a` 中间记录分开保存，不覆盖旧失败记录

## 1. 接受结果

```text
node acceptance/run-acceptance.mjs
tests 97 / pass 96 / fail 0 / skip 1
exit 0
```

- 1 个 skip 是“无 Node/Python 干净 Windows 环境打开 ZIP”，真实缺口，未删除。
- 75afc8f 的并发/双击单任务、创建期关闭、closeAll 会话清理、Wayback 原始行数续页、
  非法日期、UTC 跨月/边界全部通过。
- 原先在 `2c2438a` 仍失败的 6 个非法主机输入（`*.*.example.com`、`*example.com`、
  `exa*mple.com`、`example.com*`、`foo.*.example.com`、`foo_bar.example.com`）
  在 `0859d1f` 均被拒绝，T1 矩阵通过。
- R7：记录预算、响应字节预算、恶意 cdx 端点计数、缺失 cdx-api 计数、
  copyReasons/copySelection 的 source/revision 校验、`RowView.interesting` 均通过。

## 2. 真实 Electron 代理

```text
PROXY_ACCEPTANCE_RESULT
```

| 场景 | 结果 |
|---|---|
| 生产配置 + 环回 | **gap**：Chromium 默认 bypass loopback（origin 1/proxy 0）；测试专用 `<-loopback>` 才验证协议路径 |
| HTTP 无认证 | PASS，proxyHits=1 |
| HTTP 认证（仅匹配挑战） | PASS，authorized=1 |
| SOCKS5 免认证 | PASS，socksHits=1 |
| SOCKS5 认证 | PASS（明确拒绝：`PROXY`，originHits=0、socksHits=0；拒绝不计为认证成功） |
| 代理连接失败 | PASS，`ERR_PROXY_CONNECTION_FAILED`，originHits=0（不直连） |

原始发现（无认证 SOCKS/HTTP 成功；SOCKS 认证不支持；loopback 默认 bypass）保留在
代理验收脚本与历史报告中。

## 3. 构建、打包与开发自测（仅记录，不替代独立验收）

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run dist:win` | 通过（win-unpacked + ZIP） |
| 本地 ZIP | 153,301,281 bytes，SHA-256 `87d3dfb38530c3cf0c7e4d414133f924fa1fae9d35308e3452a486bc49aee10a` |
| `npm test` | 63 passed |
| `npm run test:e2e` | 18 passed |
| 独立打包验收 | `PACKAGED_ACCEPTANCE_RESULT {"ok":true,"status":"完成","rows":3,"csvBytes":210}` |
| 独立打包双击 | `DOUBLE_CLICK_ACCEPTANCE_RESULT {"ok":true,"waybackHits":1,...}` |

## 4. 未覆盖 / 边界

- 无 Node/Python 干净 Windows 环境 ZIP 验收仍为 skip。
- 主题契约（`themeGet`/`themeChanged`）与 `RowView.interesting`、`copyReasons`
  已在核心/契约层存在；**正式 renderer 尚未消费新桥**，不能据契约测试宣称
  主题/原因复制/高亮界面通过。
- 真实外部来源、macOS/Linux、10k 真实 UI 渲染未测。
- 前端最终接线后的集成 SHA 仍需复测；本报告只代表固定候选 `0859d1f` 的核心/接口与
  打包独立验收结果。
