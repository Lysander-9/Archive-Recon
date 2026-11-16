# 代理配置矩阵（测试交接）

本文件只描述独立 acceptance 的观察与待核对契约，不修改产品默认代理。

## resolveProxy 实测（同一官方 URL `https://index.commoncrawl.org/collinfo.json`，本进程/任务 session）

| 对象 | 脱敏 resolveProxy | 说明 |
|---|---|---|
| `session.defaultSession` | `PROXY 127.0.0.1:7890` | 本机 Electron/Chromium 的 OS 系统代理实际解析；此前仅用 `netsh winhttp` 判“无代理”不充分 |
| explicit `direct` task session | `DIRECT` | 显式直连契约 |
| `system` task session | `PROXY 127.0.0.1:7890` | OS 系统代理（不是 HTTPS_PROXY） |
| fixed task session | `PROXY 127.0.0.1:18080` | 测试固定代理地址 |

本进程 `HTTPS_PROXY/HTTP_PROXY/https_proxy/http_proxy` 均未设置；环境变量不是上述 OS/fixed 模式的结果来源。

| 模式 | 已确认/待核对契约 | 本次观察 | 判定 |
|---|---|---|---|
| 显式 `direct` | 用户明确选择直连，忽略 `HTTP(S)_PROXY` 是**已确认契约，不是缺陷** | resolveProxy=DIRECT；设置 HTTPS_PROXY 后仍直连 | PASS（`explicit-direct-ignores-env`） |
| OS `system` | 指操作系统代理（Windows 系统代理），不是环境变量；环境变量不是该模式契约 | resolveProxy=`PROXY 127.0.0.1:7890`；本机测试代理无法替代该 OS 代理做外部验证 | 解析正确；外部可用性**未验证**（不是“无 OS 代理”） |
| 环境建议/手动应用 | 产品是否从 `HTTP_PROXY/HTTPS_PROXY` 提议、是否要求用户确认，契约未定 | 环境变量未设置；direct 不自动应用 | **待核对** |
| `fixed` HTTP 代理 | 用户选择固定代理后，请求经该代理；失败不直连 | CONNECT 免认证 PASS；HTTP 认证 PASS（authorized=1） | PASS |
| `fixed` HTTPS 代理（代理端点 TLS） | 代理端点 https 的 CONNECT | 受控测试 PASS（proxyHits=1） | PASS（测试证书信任） |
| `fixed` SOCKS5 | 免认证 SOCKS5 可用；SOCKS 认证不支持时启动前拒绝 | 免认证 PASS；认证拒绝 `PROXY`、零请求 | PASS/如实拒绝 |
| 代理连接拒绝 | 不直连 | `ERR_PROXY_CONNECTION_FAILED`，originDelta=0 | PASS |
| 代理认证失败（错误凭据） | 应明确为 407/auth，不作瞬时网络重试 | 仍为 `ERR_TOO_MANY_RETRIES` / kind=network | **FAIL（a1ca968 未闭环，待修复）** |
| DNS 失败（直连） | 可证明为 DNS/解析 | 直连无效主机：`ERR_NAME_NOT_RESOLVED` + “域名解析失败” | PASS（代理隧道下的 EMPTY_RESPONSE 不猜成 DNS） |
| TLS 不受信 | 可诊断证书错误 | `ERR_CERT_AUTHORITY_INVALID` + kind=tls | PASS |
| 429/502/503/504 | 摘要保留 HTTP 状态/阶段/attempts | 原因含状态、context.httpStatus、attempts=3 | PASS |
| 超时 | 可信 timeout 文本/TIMEOUT 可诊断 | `TIMEOUT` PASS；原 R9 的非 Chromium 文本 `Request timed out...` 仍未分类（原断言保留） | 部分（待后端兼容文本） |

## 测试专用条件（不冒充生产配置）

- 环回目标使用 `proxyBypassRules: "<-loopback>"`；生产未设置，仅验证协议路径。
- 本地 HTTPS 源站使用 `fixtures/tls` 自签证书并 `setCertificateVerifyProc` 信任；生产 TLS 校验未关闭。
- 因此 HTTPS 代理成功只证明受控链路，不证明用户实际代理/线上 HTTPS 可用。

## 标准客户端对照（已定位）

- 本地受控 HTTPS 端点 + 同一测试 CONNECT 代理：产品传输成功（collinfo/pageCount/2 行），curl 经同一测试代理本地请求也失败（`000/0/8s`）。差异已定位在**测试代理/curl 层**，不是产品请求层；不能再用该 curl 结果判产品通过或失败。
- 官方 collinfo：此前直连 curl 200/35501；本次未重复外部请求。产品经测试代理最后一次为 `ERR_EMPTY_RESPONSE`，仍作为未决 harness/外部差异，不签通过。
