# 验收夹具说明

本目录中的所有文件都是**人工构造的合成响应**，不是对 Wayback Machine 或
Common Crawl 的实时抓取，也不包含任何真实凭据或个人数据。

## 为什么使用合成夹具

- NEPT-3 验收要求测试不访问外部目标，且结果必须可重复。
- 现有测试只覆盖域名校验和 Common Crawl 分页的少量局部行为；验收需要覆盖
  成功、零结果、重复 URL、字段缺失、畸形行、分页元数据等场景。
- 夹具的**结构**依据仓库内 `api_client.py` 的请求参数与解析代码推导，
  具体数值、URL、摘要均为虚构。

## 文件清单

| 文件 | 模拟对象 | 用途 |
|---|---|---|
| `wayback_page_0.json` | Wayback CDX `output=json` 响应：首行字段名，随后是数据行 | 正常解析、字段标准化、页内重复 URL、分号 MIME、空 length |
| `wayback_page_1.json` | CDX 第二页 | 跨页重复 URL、`has_more` 收敛、`page` 参数 |
| `wayback_empty.json` | 空数组 | 零结果路径 |
| `cc_page_0.ndjson` | Common Crawl Index 的逐行 JSON 响应 | 正常解析、同页重复 URL、故意保留一行非法 JSON 以观察“静默丢行” |
| `cc_page_1.ndjson` | Common Crawl 第二页 | 分页、域名范围外记录（验证服务端/客户端职责） |
| `cc_collinfo.json` | `collinfo.json` 索引列表 | 时间范围选择；`cdx-api` 字段存在但基线代码未使用 |
| `cc_page_count.json` | `showNumPages=true` 响应 | 服务端页数元数据 |

## 必须重新核实的契约假设

以下假设来自现有代码，**尚未**与官方文档或经批准的固定响应核对：

1. Wayback CDX 的 `matchType=domain` 是否按“根域 + 所有子域”匹配。
2. Common Crawl 的 `url=*.example.com` 是否包含裸域 `example.com` 本身。
3. `CC-MAIN-YYYY-NN` 中的 `NN` 是否可以被当作 ISO 周号映射到自然月
   （基线代码如此近似；`collinfo.json` 中的 `cdx-api`/时间覆盖字段被忽略）。
4. `collinfo.json` 与 `showNumPages` 响应的其他字段是否会影响结果完整性。

这些项目在 `ACCEPTANCE_CHECKLIST.md` 中标记为 `BLOCKED`，不得依据夹具结果
宣称来源覆盖完整。若后续取得官方契约或经批准的录制样本，应更新夹具并在
`BASELINE_REPORT.md` 记录来源与获取时间。
