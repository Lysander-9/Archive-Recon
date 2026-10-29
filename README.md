# 渗透测试信息搜集工具

基于 Wayback Machine 和 Common Crawl 的网页存档数据搜集 GUI 工具，用于渗透测试前期信息收集阶段，快速检索目标域名的历史 URL、状态码、文件类型等存档记录。

## 功能特性

### 数据源
- **Wayback Machine CDX API** — 查询 `web.archive.org` 存档的目标域名历史快照
- **Common Crawl Index API** — 查询 `index.commoncrawl.org` 按月索引的网页爬取记录
- 页数通过 `showNumPages` 查询；`pageSize` 表示压缩索引块数，不是 URL 条数。每个索引最多读取 5 页，超出时标记为部分结果。

### 查询能力
- 支持泛域名查询（`*.example.com` 匹配所有子域）
- 两个数据源可独立查询，互不阻塞
- Wayback Machine：流式分页加载，每页 50 条，最多 20 页（1000 条），支持随时停止
- Common Crawl：按索引逐月加载，滚动到底部自动加载下一个索引；支持按时间范围筛选（最近 N 个月 / 指定年月 / 全部时间）

### 结果展示与筛选
- 表格展示：行号、快照时间、状态码、长度、文件类型、完整 URL
- 列排序：点击列标题切换升序/降序，带 ▲/▼ 箭头指示
- 列宽自适应：根据当前页内容自动调整列宽，URL 列拉伸填满剩余空间
- 多维度筛选：
  - 状态码（下拉选择 + 手动输入，支持逗号多值和 `!` 排除）
  - 文件类型（下拉选择 + 模糊匹配）
  - URL 关键词（支持 `!` 排除）
  - 域名（下拉自动填充查询结果中的子域名及条目数量，支持泛域匹配）
- 敏感文件高亮：自动识别 37 种敏感路径模式（`.env`、`.bak`、`.git/config`、`wp-config.php`、`.sql`、`.pem` 等），以金色背景标注
- 字体缩放：小 / 默认 / 中 / 大 / 超大 五档可选

### 分页与导出
- 每页行数可选：20 / 50 / 100 / 200 / 500 / 1000
- 页码跳转：输入页码 + GO 按钮，支持回车确认
- 导出 CSV / JSON（导出当前筛选后的全部结果）

### 界面与桌面适配
- 根据当前屏幕分辨率自动计算初始窗口尺寸，并在桌面居中显示
- 最小窗口尺寸会根据可用屏幕空间动态调整，兼顾常见桌面与较小分辨率
- 查询区采用双行卡片布局，将输入项、运行状态和查询操作分层展示
- 筛选区采用可伸缩网格布局，窗口尺寸变化时输入框可自动分配宽度
- 统一输入框、按钮、标签页、表格、分页栏的颜色、圆角、边框、字体和间距
- 支持 CustomTkinter 系统外观模式，分别适配浅色和深色桌面主题
- 表格包含统一表头、选中状态和敏感结果高亮样式

### 其他
- 代理支持：HTTP / HTTPS / SOCKS 代理，可随时切换
- 复制功能：`Ctrl+C` 复制选中行 URL，右键菜单支持「复制 URL」和「复制整行数据」
- 自定义可滚动下拉组件（`ScrollableComboBox`），解决 CTkComboBox 下拉列表无法滚动的问题

## 体验与查询说明

- 常用筛选项保持在工具栏中，域名筛选等较少使用的选项收纳在「高级筛选」中；敏感路径可一键筛出。
- 查询前会检查域名格式；无结果、筛选无匹配、索引失败和部分结果都有对应提示。
- Common Crawl 使用服务端 `showNumPages` 元数据确定分页。`pageSize` 代表压缩索引块数，并非 URL 条数；每个索引最多读取 5 页，超过上限会标记为部分结果。
- Common Crawl 请求按索引串行执行，分页请求之间至少等待 1 秒，以降低连续请求压力。
- CSV / JSON 导出的是当前筛选条件匹配的全部记录，不限于表格当前页。
- Windows 启动脚本使用程序目录下的 `.venv`（存在时），并在启动前检查 Tkinter 和项目依赖；不再依赖原开发机上的固定路径。

## 环境要求

- Python 3.10+
- Windows：Python 安装需包含 Tcl/Tk（`tkinter`）；精简或嵌入式 Python 环境通常不带此组件。
- Windows / macOS / Linux（需支持 GUI 显示）

## 安装

```bash
# 克隆仓库
git clone https://github.com/Lysander-9/pentest-archive-tool.git
cd pentest-archive-tool

# 创建虚拟环境（推荐）
uv venv .venv

# Windows：使用包含 Tcl/Tk 的 Python 3.10+
uv pip install --python .venv\Scripts\python.exe -r requirements.txt

# macOS / Linux：将路径替换为 .venv/bin/python
# uv pip install --python .venv/bin/python -r requirements.txt
```

## 使用方法

### 启动

```bash
.venv\Scripts\python.exe main.py
```

Windows 用户也可双击 `start.bat` 启动。脚本优先使用项目 `.venv`，并在启动前检查 Tkinter 和所需依赖。

### 基本操作

1. 在顶部输入「目标域名」（如 `example.com` 或 `*.example.com`）
2. 如需代理，展开「网络设置」，填入代理地址并点击「应用代理」
3. 点击 **Wayback 查询** 或 **Common Crawl 查询** 开始检索
4. 结果加载完成后，使用工具栏筛选、排序、搜索
5. 可导出为 CSV 或 JSON 文件

### 筛选语法

| 筛选项 | 说明 | 示例 |
|--------|------|------|
| 状态码 | 下拉选择或手动输入，逗号分隔多值 | `200,301,404` |
| 状态码排除 | `!` 前缀排除指定值 | `!404,!500` |
| 文件类型 | 下拉选择或手动输入，模糊匹配 | `text/html` |
| URL 搜索 | 关键词匹配，支持排除 | `admin` 或 `!static` |
| 域名 | 下拉选择（自动填充）或手动输入 | `www.example.com` 或 `!cdn.example.com` |

## 项目结构

```
pentest-archive-tool/
├── main.py              # GUI 主程序（CustomTkinter）
├── api_client.py         # Wayback CDX & Common Crawl API 客户端
├── requirements.txt      # Python 依赖
├── 启动工具.bat          # Windows 快速启动脚本
└── README.md
```

## 技术栈

| 组件 | 技术 |
|------|------|
| GUI 框架 | CustomTkinter 6.0+（基于 tkinter） |
| 表格组件 | ttk.Treeview |
| HTTP 请求 | requests |
| 数据处理 | pandas |
| 并发查询 | threading + threading.Event（可取消） |

## API 说明

### Wayback Machine CDX API

- 端点：`https://web.archive.org/cdx/search/cdx`
- 参数：`url`、`matchType`、`output=json`、`fl=timestamp,original,statuscode,length,mimetype`、`collapse=urlkey`
- 匹配模式：`domain`（匹配域名及所有子域）

### Common Crawl Index API

- 索引列表：`https://index.commoncrawl.org/collinfo.json`
- 单索引查询：`https://index.commoncrawl.org/{index_id}-index?url=*.example.com&output=json&page=0`
- 按时间范围筛选可用索引（最近 N 个月 / 指定年月 / 全部）

## 许可证

MIT License
