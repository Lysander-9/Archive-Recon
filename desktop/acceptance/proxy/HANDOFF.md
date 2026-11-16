# 代理故障验收补丁交接（本地）

- 基线：发布 main `5a548b37a80ad11f9f6541643a805040f112dd9d`
- 本地提交：`1ba4c1f`（相对基线仅 `desktop/acceptance/` 变化；未推远程）
- 补丁：随本评论附件的 `proxy-acceptance-5a548b3.patch`（`git diff --binary 5a548b3 1ba4c1f -- desktop/acceptance`）
- 应用：在 `5a548b3` 干净检出执行 `git apply /path/proxy-acceptance-5a548b3.patch`

## 最短运行

```powershell
cd desktop
npm ci                       # 若已有同锁文件依赖可复用
npm run build
node acceptance/run-acceptance.mjs
node acceptance/prepare.mjs
.\node_modules\electron\dist\electron.exe acceptance\proxy\generated\run-https-proxy-acceptance.cjs
```

- `ARCHRECON_OFFICIAL_HEALTH=1` 可额外执行少量官方 collinfo 对照（默认不请求外部）。
- 需要 Node 26.13.0 / Electron 45.3.1（锁文件一致）。

## 预期失败（修复前）

1. `node acceptance/run-acceptance.mjs`：**108 tests / 102 pass / 5 fail / 1 skip**
   - R9 五例：429/503/代理/TLS/超时被摘要吞成泛化 network；
   - 1 skip：无 Node/Python 干净 Windows ZIP（保留）。
2. 代理脚本：`https-proxy-tls`、CONNECT、认证、SOCKS5 等通过；
   `proxy-auth-failure` 仅 `ERR_TOO_MANY_RETRIES`（没有 407/auth 阶段）；
   `dns-failure` 仅 `ERR_EMPTY_RESPONSE`（不能证明 DNS）；
   `os-system-proxy` 标记 `gap`（当前机器无 OS 代理）；
   `explicit-direct-ignores-env` 按已确认契约通过；
   `official-health-control` 为未决对照 gap（curl 经测试代理超时，产品成功）。

## 不修改/不放宽

- 未修改产品、默认代理、远程分支；
- R9 断言保持“摘要必须能诊断根因”，未改成“通过”；
- 测试专用 `<-loopback>` 与自签证书信任已在脚本/CONFIG_MATRIX 明确标注；
- 修复版返回后必须用同一脚本与 R9 复测页数/结果读取路径，不能只用单独 collinfo 成功代表
  完整连通性；干净 Windows 分发 skip 保留。
