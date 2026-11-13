# TypeScript/Electron 独立验收执行报告

- 日期：2026-11-13
- 分支：`agent/agent/133403d1c75a-ts-acceptance`（从原始基线 `8e6aaf9` 建立）
- 范围：仅新增 `desktop/acceptance/`；未修改共享 `package.json`/lock/契约/生产代码，未修改旧 Python 成果
- 环境：Windows 11 Pro 10.0.26300、Node **v26.13.0**、npm 11.20.0
- 依赖：无；Node 原生 TypeScript 类型剥离 + 内置 `node:test`，未执行 npm install
- 网络：无；所有响应来自内存夹具，未访问 Wayback / Common Crawl / 任何外部目标
- Python：未调用（套件内有静态检查，`desktop/acceptance` 无 `.py`，无 Python 子进程）

## 1. 实际执行命令与结果

```text
node desktop/acceptance/run-acceptance.mjs
  mode=reference tests=8 (test files)
  tests 57 / pass 55 / fail 0 / skipped 2
  exit 0

node desktop/acceptance/run-acceptance.mjs --legacy
  mode=legacy tests=8
  tests 57 / pass 44 / fail 11 / skipped 2
  exit 1
```

跳过项（不是通过）：

1. `T6: desktop package/distribution contract` — `desktop/package.json` 尚未交付；
2. `T6: packaged Windows ZIP without Node/Python` — 尚无 `win-unpacked` ZIP，
   最终必检项待集成构建。

夹具哈希：`fixtures/manifest.json` 17 个条目全部与文件 SHA-256 一致，包括
官方 collinfo（35,501 字节，`a683312f…b01891a`）和原始五字段 CSV 样本
（`9e8dfc69…9bdef517`）。

## 2. 参考模式（契约应满足的行为）

55 个通过项覆盖：

- T1 合法/非法目标矩阵、非法输入 0 次 transport 调用、plain/`*.` 冻结同范围、
  Wayback `matchType=domain`/collapse、CC `url=*.`/pageSize=5、结果域名筛选；
- T2 Wayback 成功/零结果/失败/部分结果、BUSY、终态幂等；
- T2/R2 Wayback 末页与空页取消落 `stopped`，CC 末页取消落 `stopped`；
- T3 官方 `from/to` 与自然月相交（2024-10 只选 `CC-MAIN-2024-42`，排除
  `2024-38`/`2024-10`）、跨月（2024-02/03 选 `2024-10`，2025-04/05 选
  `2025-18`）、最近 3 个自然月、异常元数据“范围未知”、`cdx-api`/原始时间保留；
- T4 同批/跨批去重、完整 URL 身份、筛选/排序保持、稳定排序、0-based 分页、
  snapshot 五字段；
- T5 CSV 与基线样本逐字节一致（BOM/CRLF/引号/中文/逗号/换行）、JSON 结构一致、
  120→70 全量快照、零结果、取消、`STALE_VIEW`、写失败无临时残留；
- R1 清空/重置后 view/page/pageCount/snapshot 全空，新查询不泄漏旧结果；
- R3 CC 目标在索引列表返回前、索引之间修改输入均保持冻结目标；
- R4 CC 停止后启动 Wayback，滚动不发起 CC 请求、错误来源的 view/cancel 被拒、
  活动任务事件来源一致；
- R5 关闭后 UI sink 不再收事件、停止后立即重启任务隔离、fixed 代理失败不直连；
- T6 夹具哈希、原始样本不变、验收目录无 Python。

## 3. 缺陷敏感性证据（legacy 模式）

`legacy` 是验收目录内的**合成缺陷模型**，用于证明断言能捕获已知的 R1–R5/T1
问题；它不是 Python 产品，也不能作为产品失败结论。11 个失败的实测差异：

| 断言 | legacy 实测 | 期望 | 对应 |
|---|---|---|---|
| R1 新查询视图 | 泄漏旧查询 4 条记录 | 0 条 | R1 缓存未失效 |
| R1 导出快照 | 旧记录进入新查询导出 | 仅表头 | R1 缓存未失效 |
| R2 Wayback 末页取消 | 停在 `stopping`（3s 超时） | `stopped` | R2 末页停止 |
| R2 Wayback 空页取消 | 停在 `stopping` | `stopped` | R2 空页停止 |
| R2 CC 末页取消 | 停在 `stopping` | `stopped` | R2 跨来源 |
| R3 首索引前改输入 | `*.other.example` | `*.example.com` | R3 目标冻结 |
| R3 索引之间改输入 | 后续索引 `*.other.example` | `*.example.com` | R3 目标冻结 |
| R4 CC 停止后滚动 | `accepted=true` 且发出 CC 请求 | 不发起 CC 请求 | R4 来源隔离 |
| R4 错误来源 view/cancel | 被接受 | `INVALID_INPUT` | R4 来源校验 |
| R5 关闭后事件 | sink 3 条（关闭时 2 条） | 不再增加 | R5 关闭后写入 |
| R5 fixed 代理失败 | 1 次 direct 回退 | 0 次 direct | 代理不得静默直连 |
| T1 非法输入 | `user:pass@example.com` 被接受并启动 | `INVALID_INPUT`、0 调用 | T1 严格校验 |

原始执行输出可由以下命令复现：

```bash
node desktop/acceptance/run-acceptance.mjs --legacy
```

## 4. 未覆盖 / 阻塞

| 项 | 状态 | 说明 |
|---|---|---|
| 生产 `src/contracts`、domain/application/adapters | 未交付 | 当前使用验收参考实现；契约提交后替换 `harness/iut.ts` 的导入，断言不变 |
| Electron 安装/构建/启动 | 未执行 | 属集成负责人；依赖锁文件未在本轮安装 |
| Playwright Electron 冒烟 | 未执行 | 依赖实际窗口与 Electron 组合 |
| `win-unpacked` Windows ZIP | 未执行 | 无构建产物；无 Node/Python 用户环境打开 ZIP 是最终必检项 |
| 真实来源适配器 | 未执行 | 测试使用内存 transport；真实网络边界待契约实现 |
| 1366×768/1202×680/1040×620、浅深主题 | 未执行 | renderer 正式实现后验收 |
| 10,000 条性能阈值 | 未执行 | 需实际渲染/筛选路径 |
| macOS/Linux | 未验证 | 仅 Windows 环境 |
| 生产打包白名单（排除 .py/.venv/tests） | 未执行 | 依赖 `package.json`/builder 配置交付 |

## 5. 后续集成复测

1. 契约/骨架提交返回后，在固定集成 SHA 上：
   - 将 `desktop/acceptance/harness/iut.ts` 的 `createIut` 接到生产适配器；
   - 运行 `node desktop/acceptance/run-acceptance.mjs`，所有非 skip 断言必须通过；
   - 不得删除断言、放宽字段名或把参考实现当作产品通过。
2. 后端完成 Electron/Playwright/`dist:win` 后：
   - 用真实打包应用运行窗口/结果/停止重启/五字段导出；
   - 在无 Node、无 Python 的 Windows 用户环境解压 `win-unpacked` ZIP 启动并完成
     本地数据流程；
   - 记录 ZIP 哈希、Electron 版本、Node/npm 构建版本与未签名状态。
3. UI 提交后补 1366×768/小窗口/主题/分页可达到性证据；独立审查在固定集成 SHA。

**结论：验收套件与夹具已可运行，参考模式 55/55 非 skip 断言通过，legacy 模式
捕获 R1–R5/T1 共 11 个失败；但尚无新产品构建、真实 Electron 窗口或 Windows ZIP，
因此当前不能判定新产品验收通过。**
