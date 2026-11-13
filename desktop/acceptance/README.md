# 独立验收（TypeScript / Electron）

本目录是 NEPT-3 非 Python 重开发的独立验收套件，按 ADR-002 的契约编写。
它不修改共享 `package.json`/`package-lock.json`/`src/contracts` 或任何生产代码，
也不调用 Python。

## 当前状态（2026-11-13）

- 夹具、固定时钟、来源响应、代理矩阵与 T1–T6/R1–R5 行为断言已就绪；
- 套件自带一个**符合 ADR 契约的参考实现**（`harness/reference-iut.ts`）用于在
  生产契约提交前验证测试本身；它**不是产品代码**，不是验收通过证据；
- 参考模式：57 tests，55 pass，2 skipped（等待 `desktop/package.json` 与
  Windows ZIP）；
- 缺陷敏感性证据：`ARCHRECON_IUT_MODE=legacy` 用同一套断言复现已知的
  R1–R5/T1 缺陷，得到 11 个失败（见 `reports/2026-11-13-ts-acceptance.md`）；
- 生产 `src/` 契约、Electron 启动、Playwright、打包 ZIP 尚未交付，因此当前
  **不能**判定新产品通过验收。

## 运行

环境：Node **26.13.0** 或任何支持原生 TypeScript 类型剥离的 Node（>=22.6）。
无需 `npm install`，不读取系统时钟，不访问外部目标。

```bash
# 参考模式（契约正确时应全绿；当前 2 个 T6 条目显式 skip）
node desktop/acceptance/run-acceptance.mjs

# 缺陷敏感性证据（合成 legacy 行为，非 Python 产品）
node desktop/acceptance/run-acceptance.mjs --legacy

# 直接使用 Node 内置 runner
node --test desktop/acceptance/tests/*.test.ts
```

## 目录

| 路径 | 作用 |
|---|---|
| `harness/contracts.ts` | ADR-002 v1 的可移植验收类型（不导入共享 contracts） |
| `harness/clock.ts` | UTC 固定时钟、自然月窗口、最近 N 个自然月 |
| `harness/fixtures.ts` | 夹具路径、哈希清单、读取工具 |
| `harness/fixture-transport.ts` | 纯内存响应/延迟/代理失败传输；无 socket |
| `harness/reference-iut.ts` | 符合契约的参考实现 + 故意 legacy 模式 |
| `harness/iut.ts` | 被测实现选择器；契约提交后在此接生产适配器 |
| `fixtures/export/` | 原始五字段字节样本（CSV 强断言，JSON 结构/编码断言） |
| `fixtures/metadata/` | 官方 collinfo 固定样本 + 合成异常元数据 |
| `fixtures/sources/` | Wayback CDX、CC NDJSON、showNumPages 合成响应 |
| `fixtures/clock/`、`fixtures/proxy/` | 固定时钟实例、代理模式/失败矩阵 |
| `tests/t1-target.test.ts` | 目标校验、零调用、两来源请求范围、域名筛选 |
| `tests/t2-lifecycle.test.ts` | 成功/零结果/失败、BUSY、末页/空页取消终态 |
| `tests/t3-time-metadata.test.ts` | 官方区间相交、跨月、最近 N 月、异常元数据 |
| `tests/t4-results.test.ts` | 同批/跨批去重、筛选保持、稳定排序、分页、R1 |
| `tests/t5-export.test.ts` | 五字段字节兼容、全量快照、取消/失败、原子写入 |
| `tests/r3-r4-isolation.test.ts` | CC 目标冻结双阶段、跨来源滚动/回调隔离 |
| `tests/r5-close-proxy.test.ts` | 关闭后无 UI 事件、停止重启、代理失败不直连 |
| `tests/t6-packaging.test.ts` | 夹具哈希、无 Python、打包/ZIP 待交付 skip |
| `reports/` | 实际执行结果与未覆盖项 |

## 断言口径（不放宽字段/字节）

- CSV：与 `fixtures/export/reference-baseline-sample.csv` **逐字节相等**
  （UTF-8 BOM、CRLF、五字段顺序 `timestamp,status_code,length,file_type,url`）。
- JSON：同一组记录的键顺序、值、UTF-8（中文不转义）与基线结构一致；
  基线样本由 Windows 文本模式写出，含 CRLF，原样保留，测试按结构 +
  行尾归一化比较（ADR-002 只对 CSV 要求 CRLF 字节兼容）。
- 内部 `source`/`rawTimestamp`/`indexId`/`rowId` 与界面行号不得导出。
- 时间：只使用 `fixtures/clock/fixed-clocks.json`；禁止系统时钟。
- CC 索引：只按官方 `from/to` 与自然月 `[月初, 下月初)` 相交选择；
  缺失/非法/倒置为“范围未知”，不得退回索引 ID 周号公式。
- 代理：fixed 失败返回 `NETWORK` 且 `proxyUsed=true`、`directAttempted=false`；
  不出现 direct 回退。
- 关闭：close 后 UI sink 不得再收到事件；停止/重启任务互相隔离。

## 契约提交后的对接

1. 后端交付 `src/contracts`、`src/domain`、`src/application`、`src/main/adapters`
   后，在 `harness/iut.ts` 中把 `createIut` 替换为生产适配器；`tests/` 与
   `fixtures/` 不改断言。
2. 运行参考模式；**任何失败就是产品缺陷**，不得通过修改断言/放宽字段来消除。
3. Electron/Playwright 冒烟与 `win-unpacked` ZIP 检查加入后，删除/替换
   `t6-packaging.test.ts` 的两个 skip；Windows 无 Node/Python 用户环境打开
   ZIP 是最终必检项。
4. legacy 模式仅用于证明测试能捕获 R1–R5/T1 缺陷，不得用于产品判定。
