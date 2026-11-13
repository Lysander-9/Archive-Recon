# 代理配置矩阵（测试交接）

本文件只描述独立 acceptance 的观察与待核对契约，不修改产品默认代理。

| 模式 | 已确认/待核对契约 | 本次观察 | 判定 |
|---|---|---|---|
| 显式 `direct` | 用户明确选择直连，忽略 `HTTPS_PROXY` 是**已确认契约，不是缺陷** | 设置 `HTTPS_PROXY` 后仍直连，proxyHitsDelta=0，本地目标 200 | PASS（`explicit-direct-ignores-env`） |
| OS `system` | 指操作系统代理（Windows 系统代理），不是环境变量；环境变量不是该模式契约 | 当前机器 `netsh winhttp show proxy` = 直接访问，无系统代理可测 | **GAP/待核对**，不能判错，也不能据此证明用户系统代理可用 |
| 环境建议/手动应用 | 产品是否从 `HTTP_PROXY/HTTPS_PROXY` 提议、是否要求用户确认，契约未定 | 默认/显式 direct 下未自动应用；fixed 需用户选择后生效 | **待核对**（未用环境变量断言产品失败） |
| `fixed` HTTP 代理 | 用户选择固定代理后，请求经该代理；失败不直连 | 受控 HTTP CONNECT 免认证 PASS；HTTP 认证 PASS（authorized=1） | PASS |
| `fixed` HTTPS 代理（代理端点 TLS） | 代理端点 https 的 CONNECT | 受控测试 PASS（proxyHits=1） | PASS（测试证书信任） |
| `fixed` SOCKS5 | 免认证 SOCKS5 可用；SOCKS 认证不支持时启动前拒绝 | 免认证 PASS；认证拒绝由既有脚本断言 `PROXY`、零请求 | PASS/如实拒绝 |
| 代理连接拒绝 | 不直连 | `ERR_PROXY_CONNECTION_FAILED`，originDelta=0 | PASS |
| 代理认证失败 | 应可区分 407/auth 阶段 | 仅 `ERR_TOO_MANY_RETRIES` | **FAIL（诊断缺口）** |
| DNS 失败 | 应可区分 DNS/resolve 阶段 | 仅 `ERR_EMPTY_RESPONSE` | **FAIL（不足以证明 DNS）** |
| TLS 不受信 | 可诊断证书错误 | `ERR_CERT_AUTHORITY_INVALID` | 可诊断（code 仍 NETWORK） |
| 429/503 | 摘要应保留 HTTP 状态 | `fetchText` 消息含状态，但 JobManager 摘要仅 network | **FAIL（R9）** |
| 超时 | TIMEOUT 可见 | `fetchText` TIMEOUT，摘要仅 network | **FAIL（R9）** |

## 测试专用条件（不冒充生产配置）

- 环回目标使用 `proxyBypassRules: "<-loopback>"`，因为 Chromium 默认 bypass loopback；
  生产 `buildProxyConfig` 未设置该规则。此 override 只用于验证代理协议路径。
- 本地 HTTPS 源站使用 `fixtures/tls` 的测试自签证书，并通过
  `setCertificateVerifyProc(() => 0)` 信任；生产 TLS 校验未被关闭。
- 因此：HTTPS CONNECT/TLS 代理成功只证明受控链路，不证明用户实际代理或线上 HTTPS 一定可用。

## 标准客户端对照

同一受控本地代理/相同官方目标/相同条件：产品传输成功（200/35501 bytes）；直接 curl 成功
（200/35501 bytes）；curl 经测试代理超时（000/0/20s），而产品成功。该差异尚未定位在
测试代理实现或请求层，**不能据此签通过**，作为未决对照项保留。
