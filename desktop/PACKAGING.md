# Windows 打包说明（产品身份、图标与签名状态）

本文件说明 `electron-builder.json` 的打包契约，以及"未签名但身份正确"这一取舍的落地方式。
构建命令与目录说明见 `README.md`。

## 1. 身份字段从哪里来

`Archive Recon.exe` 的版本资源由 electron-builder 通过纯 JS 的 [`resedit`](https://www.npmjs.com/package/resedit)
写入（不需要 rcedit / winCodeSign 外部工具，也不引入新依赖）。各字段来源：

| 版本资源字段 | 取值 | 配置位置 |
|---|---|---|
| `ProductName` | `Archive Recon` | `productName` |
| `FileDescription` | `Archive Recon` | 由 `productName` 派生 |
| `CompanyName` | `Archive Recon` | `extraMetadata.author.name`（electron-builder 只从打包元数据的 `author.name` 取该字段，不改 `package.json`） |
| `LegalCopyright` | `Copyright © 2026 Archive Recon` | `copyright` |
| `LegalTrademarks` | `Archive Recon` | `win.legalTrademarks` |
| `FileVersion` | `0.1.0` | `package.json` 的 `version` |
| `ProductVersion` | `0.1.0.0` | 同上，Windows 四点式 |
| `InternalName` / `OriginalFilename` | `Archive Recon` / 空 | 由可执行文件名派生 |
| 图标 | `assets/icon.ico`（16/24/32/48/64/128/256，32bpp DIB） | `win.icon` |

**待替换项**：`CompanyName` 当前使用项目名 `Archive Recon`，不是注册法人实体。若后续有正式主体，
把 `extraMetadata.author.name` 与 `copyright` 一并改成该主体名称；两处必须同时改，否则版本资源与
版权行会不一致。

## 2. 为什么改用 `signExecutable: false`

旧配置 `win.signAndEditExecutable: false` 会**同时**跳过资源编辑与签名，导致 exe 保持 Electron 出厂身份
（`ProductName=Electron`、`CompanyName=GitHub, Inc.`、`OriginalFilename=electron.exe`、无产品图标）。

现配置：

- 删除 `signAndEditExecutable`（回到默认 `true`），保留资源编辑（名称/版本/版权/图标/执行级别）；
- 增加 `win.signExecutable: false`，只关闭代码签名。

electron-builder 26.18 的官方说明（`scheme.json`）即为：*"Set to `false` to skip Windows code signing
while still editing executable resources (icon, metadata, etc. via resedit)."*

结果：**exe 仍然未签名**（没有证书，也不购买证书），但身份、版本与图标正确。签名状态在
`README.md` 与发布说明中如实披露，不做任何"已签名"暗示。

## 3. 图标资源

- 路径：`desktop/assets/icon.ico`，随仓库提交（约 360 KB）。
- 未放在 electron-builder 默认的 `build/` 目录，因为仓库根 `.gitignore` 的 `build/` 规则会把它忽略掉；
  因此显式指定 `win.icon`。
- 格式：ICO 内含 7 个 32bpp DIB 条目，最大 256×256（electron-builder 要求 ICO 至少含 256×256 条目）。
- 该图标同时用于窗口/任务栏（由 exe 资源决定）与文件资源管理器显示。

## 4. 打包后必须核对的证据

```powershell
cd desktop
npm run dist:win

# 版本资源
$exe = "release\win-unpacked\Archive Recon.exe"
(Get-Item $exe).VersionInfo | Select-Object ProductName,FileDescription,CompanyName,
    FileVersion,ProductVersion,OriginalFilename,InternalName,LegalCopyright,LegalTrademarks

# 签名状态必须仍是未签名
Get-AuthenticodeSignature $exe | Select-Object Status

# 包白名单：asar 只应包含 dist/** 与 package.json
# （用任意 asar 读取方式列出条目，确认无源码/测试/node_modules/source map）
```

## 5. 未做的与限制

- 未购买、未申请证书，未签名；未接入时间戳服务。
- 未生成 NSIS/MSI 安装器；`zip` 目标保持现状。
- 未修改 `package.json` / `package-lock.json`、`src/**`、`scripts/verify-packaged.mjs`、`acceptance/**`。
- 版本号来自 `package.json`；升级版本只改 `package.json`，本文档无需改动。
- Windows 资源编辑已在本机实测（见交付回报的版本资源回读）；`resedit` 为 electron-builder 既有依赖，
  未新增任何包。
