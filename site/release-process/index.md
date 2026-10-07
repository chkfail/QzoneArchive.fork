---
title: 发布流程
---

# 发布流程

1. 在功能分支完成一个可审查的变更, 提交使用 Conventional Commits, 例如 `docs: add installation guide`。
2. 运行应用和文档站的构建检查(`npm run typecheck`, `npm run selftest`, `npm run build`, `npm run smoke`, `npm --prefix site run build`)。
3. 合并到 `main`。`main` 上涉及 `site/**` 的变更会触发文档工作流, 构建站点并发布 GitHub Pages。
4. 创建 Release 并填写说明。打包工作流随即在三个平台构建产物, 并把它们附加到这个 Release。

## 文档站发布

Pages 发布由 `.github/workflows/docs.yml` 执行:

- 推送到 `main` 且改动落在 `site/**` 或该工作流文件时触发, 也支持手动触发
- 使用 `npm ci --prefix site` 安装依赖, 使用 `npm run build --prefix site` 构建到 `site/dist`
- 把 `site/dist` 作为 Pages 制品上传并部署

文档部署只使用 `main` 分支的 `site/` 内容。开发或预览中的文档分支不会覆盖公开站点。

## 安装包

安装包由 electron-builder 打包, 配置在 `electron-builder.yml`, 产物输出到 `release/`。三个平台各有独立脚本, 每个脚本都会先执行一次 `npm run build`:

```bash
# Windows: NSIS 安装包
npm run package:win

# macOS: dmg 与 zip
npm run package:mac

# Linux: AppImage 与 deb
npm run package:linux
```

云端打包由 `.github/workflows/release.yml` 完成: 创建 Release 时触发(也支持手动指定已存在的标签补构建), 在 `windows-latest`, `ubuntu-latest`, `macos-latest` 三个运行器上依次执行 `npm ci`, `npm run typecheck`, `npm run selftest` 与对应的 `package:<平台>` 脚本, 最后把产物附加到该 Release。仓库没有代码签名证书, 工作流用 `CSC_IDENTITY_AUTO_DISCOVERY: "false"` 关闭签名身份的自动发现。

产物命名规则:

| 平台 | 产物 | 说明 |
|:---:|:---:|:---:|
| Windows | `QzoneArchive-<版本>-win-x64-setup.exe` | NSIS 安装包, 另附同名的 `.blockmap` |
| macOS | `QzoneArchive-<版本>-mac-<架构>.dmg` `QzoneArchive-<版本>-mac-<架构>.zip` | 架构取打包主机的架构 |
| Linux | `QzoneArchive-<版本>-linux-<架构>.AppImage` `QzoneArchive-<版本>-linux-<架构>.deb` | 架构取打包主机的架构 |

工作流按下列通配符收集产物并附加到 Release:

| 平台 | 附加文件 |
|:---:|:---:|
| Windows | `release/*.exe` `release/*.exe.blockmap` `release/latest.yml` |
| macOS | `release/*.dmg` `release/*.zip` |
| Linux | `release/*.AppImage` `release/*.deb` |

各平台的安装形态与元数据:

| 平台 | 安装形态 | 元数据 |
|:---:|:---:|:---:|
| Windows | NSIS, 当前用户安装, 不请求管理员权限, 向导语言包含简体中文与英文 | 应用标识 `io.github.chkfail.qzonearchive`, 产品名 `QzoneArchive`, 版本取 `package.json`, 图标 `build/icon.ico` |
| macOS | 磁盘映像与压缩包 | 应用标识 `io.github.chkfail.qzonearchive`, 产品名 `QzoneArchive`, 版本取 `package.json`, 图标 `build/icon.icns`, 分类 Utility |
| Linux | AppImage 与 deb | 应用标识 `io.github.chkfail.qzonearchive`, 产品名 `QzoneArchive`, 版本取 `package.json`, 图标 `build/icons/`, 分类 Utility |

打包只包含 `dist/electron/`, `dist/renderer/` 与 `package.json`, 以 asar 归档进 `resources/app.asar`, 不携带 `node_modules`。产物目录 `release/` 不进入版本追踪。

同一目录下的 `release/win-unpacked/`, 即 macOS 的 `release/mac/` 或 `release/mac-arm64/`, Linux 的 `release/linux-unpacked/`, 是不需要安装即可直接运行的免安装目录, 方便本地验证, 也可以随 Release 一起作为免安装版本分发。

应用数据默认写在用户目录下的 `.qzonearchive.fork` 目录(Windows 为 `%USERPROFILE%\.qzonearchive.fork`, macOS 与 Linux 为 `~/.qzonearchive.fork`), 归档库 `qzone-archive.sqlite3` 与 `images/`, `videos/` 子目录都在其中; 该位置不可写时自动回退到应用所在目录下的同名目录, 因此回退时安装版的数据位于 `%LOCALAPPDATA%\Programs\QzoneArchive\.qzonearchive.fork`, 解包版的数据位于 `release/win-unpacked/.qzonearchive.fork`; 也可以用环境变量 `QZA_DATA_DIR` 显式指定数据目录。升级或重装前建议提醒用户备份该目录。

代码签名与公证尚未配置, 产出的可执行文件与安装包均为未签名状态。分发时需要在 Release 说明中提示用户只从本仓库获取安装包。

从源码构建运行仍然可用:

```bash
npm ci
npm run build
npm start
```
