# 独立验收 — 候选 `2c2438a`（核心/接口中间记录）

- 日期：2026-11-13
- 分支：`agent/agent/133403d1c75a-prod-acceptance-candidate`（从 `2c2438a` 建立）
- 验收集：`75afc8f`（89 项）+ 本轮新增 R7 预算/端点/复制（6 项）= 95 项
- 环境：Windows 11 26300、Node 26.13.0、Electron 45.3.1、Playwright 1.65.0
- 仅修改 `desktop/acceptance/`；未改生产/共享文件；未使用 reference；未访问外部目标
- **本记录是中间候选，不覆盖先前 `a417955` 的失败记录**

## 1. 接受结果

```text
node acceptance/run-acceptance.mjs
tests 95 / pass 87 / fail 7 / skip 1
exit 1
```

失败全部集中在 T1 非法主机字符（6 个子用例 + 父测试）：

| 输入 | 实测 |
|---|---|
| `*.*.example.com` | `ok:true` |
| `*example.com` | `ok:true` |
| `exa*mple.com` | `ok:true` |
| `example.com*` | `ok:true` |
| `foo.*.example.com` | `ok:true` |
| `foo_bar.example.com` | `ok:true` |

`exa%6Dple.com`、`exa%20mple.com`、`example.com\foo` 已被拒绝。剩余问题需主进程
严格主机标签校验（通配符只允许最左侧单个 `*.`；拒绝内嵌 `*`、下划线等）。

已通过：并发/双击单任务、创建期关闭、closeAll 会话清理、关闭后拒绝启动、
Wayback 原始行数续页、非法日期 unknown、UTC 跨月/边界、10k 计时、五字段导出、
取消/关闭/跨来源、预算/端点/复制契约。

### 新增 R7 通过与观察

| 项 | 结果 |
|---|---|
| 记录预算 2：3 条页 → 保留 2、`record_limit=1`、partial | PASS |
| 响应字节预算：保留前页 50 条、partial | PASS（原因仅为泛化“页读取失败”，非字节上限文案；精度改进项） |
| 恶意/非法 cdx 端点：3 个 → `range_unknown count=3`、partial，未请求恶意主机 | PASS |
| 缺失 cdx-api：计数并入 range_unknown（4） | PASS |
| copyReasons / copySelection 的 source/revision 校验 | PASS |
| `RowView.interesting` 共享规则 | PASS |

## 2. 代理（真实 Electron session）

```text
PROXY_ACCEPTANCE_RESULT ...
```

| 场景 | 结果 |
|---|---|
| HTTP 无认证 | PASS，proxyHits=1 |
| HTTP 认证 | PASS，authorized=1 |
| SOCKS5 无认证 | PASS，socksHits=1 |
| SOCKS5 认证 | PASS（明确拒绝：`code=PROXY`，originHits=0、socksHits=0；不把拒绝当认证成功） |
| 代理连接失败 | PASS，`ERR_PROXY_CONNECTION_FAILED`，originHits=0 |
| 生产配置 + 环回 | gap：Chromium 默认 bypass（origin 1/proxy 0），测试专用 `<-loopback>` 才验证协议路径 |

## 3. 构建与开发自测（仅记录）

- `npm run typecheck`：通过
- `npm run build`：通过
- `npm test`：**61 passed**
- `npm run test:e2e`：**16 passed**（首次因未重建 dist 使用旧界面失败，重建后通过）
- 2c2438a 未重新打包 ZIP；发布验证在下一固定候选单独进行。

## 4. 边界

- 干净 Windows（无 Node/Python）ZIP skip 保留。
- 主题/复制/高亮契约已具备，但正式 renderer 尚未消费新桥；不能据契约测试宣称界面通过。
- 最终集成 SHA 仍需复测。
