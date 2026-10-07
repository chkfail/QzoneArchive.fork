<div align="center">

# 空间归档 (QzoneArchive)

[![Version](https://img.shields.io/badge/Version-2.0.0-red)](https://github.com/chkfail/QzoneArchive.fork)
[![License](https://img.shields.io/badge/License-GPLv3-yellow)](./LICENSE)

[English](./README_en-US.md) |
[简体中文]

</div>

---

将 QQ 空间动态、照片、视频与互动记录安全归档到本地的桌面工具，仅支持 PC 端。

> [!CAUTION]
> **近期出现因使用非仓库来源软件而导致账号信息泄露的情况，请务必仔细甄别软件来源。除本仓库发布的内容外，任何其他来源的程序均不可信，请勿下载或使用。**

> 本项目 fork 自 https://github.com/Gaoshu705/QzoneArchive

## 功能

- **完整归档**：还原原始动态正文、图片、视频和评论，按「本人动态」「好友动态」「留言」分类整理
- **断点续传**：中断后自动从上次位置继续，已归档的内容不会丢失
- **频率保护**：每 10 分钟最多请求 300 页，触发限流后安全暂停，倒计时结束即可继续
- **互动还原**：查看每条动态的点赞用户和评论回复，支持互动排行榜
- **本地存储**：所有数据以 SQLite 保存在用户目录下的 `.qzonearchive.fork` 目录（该目录无写权限时自动改用应用所在目录下的同名目录），不上传任何服务器
- **HTML 导出**：支持按分类或选中导出为独立 HTML 文件，可离线浏览
- **媒体时光轴**：按年份浏览归档的照片和视频，视频支持按需缓存
- **暗色模式**：跟随系统或手动切换
- **仅支持 PC 端**：Windows（优先）、Linux 与 macOS 桌面端

## 截图

| 仪表盘 | 归档内容 |
|--------|----------|
| ![仪表盘](public/runtime/仪表盘.png) | ![归档内容](public/runtime/归档内容.png) |

| 媒体时光轴 | 归档任务 |
|-----------|----------|
| ![媒体时光轴](public/runtime/媒体时光轴.png) | ![归档任务](public/runtime/归档任务.png) |

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面外壳 | Electron 44 |
| 前端 | Vue 3 + TypeScript + Vite |
| UI 组件 | PrimeVue 4 |
| 状态管理 | Pinia |
| 本地数据库 | SQLite (node:sqlite) |
| HTTP 客户端 | Node 全局 fetch (undici) |
| 打包 | electron-builder |


## 目录结构

```
QzoneArchive.fork/
├── .github/
│   ├── ISSUE_TEMPLATE/         # Issue 模板
│   └── workflows/              # 质量检查, 文档站发布, Release 打包
├── build/                      # 打包图标(ico, icns 与 png 尺寸集)
├── public/                     # README 截图
├── scripts/                    # 开发启动与自检脚本
├── site/                       # VitePress 文档站
├── src/
│   ├── main/                   # Electron 主进程
│   │   ├── commands/           # 命令实现(按域分文件)
│   │   ├── core/               # 业务核心(纯 Node, 不依赖 Electron)
│   │   ├── index.ts            # 主进程入口
│   │   ├── ipc.ts              # 命令路由
│   │   ├── paths.ts            # 数据根目录解析与越界校验
│   │   └── protocol.ts         # qza:// 本地文件协议
│   ├── preload/                # 桥接注入
│   ├── renderer/               # Vue 前端
│   │   ├── components/         # 通用组件
│   │   ├── layouts/            # 应用外壳
│   │   ├── router/             # 路由表
│   │   ├── stores/             # Pinia 状态管理
│   │   ├── styles/             # 全局样式
│   │   ├── utils/              # 工具函数与后端命令封装
│   │   └── views/              # 页面组件
│   └── shared/                 # 桥接契约与共享类型
├── COPYRIGHT                   # 版权与许可说明
├── LICENSE                     # GPLv3 许可证
├── README.md                   # 中文说明(核心)
├── README_en-US.md             # 英文说明
├── electron-builder.yml        # 打包配置
├── package.json                # 依赖与脚本入口
└── vite.config.ts              # 前端构建配置
```


## 开发

### 前置要求

- [Node.js](https://nodejs.org/) 20+
- 无需额外运行时：应用自带 Electron 与 Chromium 内核，Windows 不再需要系统 WebView2

### 启动开发环境

```bash
# 安装依赖（会同时下载 Electron 二进制）
npm install

# 启动开发环境（拉起 Vite 开发服务器、编译主进程并打开窗口）
npm run dev

# 仅启动前端开发服务器
npm run dev:renderer
```

### 构建

```bash
# 类型检查(渲染进程 + 主进程)
npm run typecheck

# 完整构建(主进程 + 渲染进程)
npm run build

# 核心逻辑自检(游标解析与归档数据库状态层)
npm run selftest

# 启动自检(启动应用, 检查桥接, 页面挂载与一批真实命令调用)
npm run smoke
```

### 打包

打包由 electron-builder 完成, 配置在 `electron-builder.yml`, 产物输出到 `release/`。三个脚本都会先执行一次完整构建:

```bash
# Windows: NSIS 安装包, 当前用户安装, 不需要管理员权限
npm run package:win

# macOS: 磁盘映像与压缩包
npm run package:mac

# Linux: 通用可执行文件与 deb 包
npm run package:linux
```

打包只包含 `dist/electron/`, `dist/renderer/` 与 `package.json`, 内容以 asar 归档在 `resources/app.asar` 内, 不携带 `node_modules`。应用图标放在 `build/`, 安装向导与各平台设置见 `electron-builder.yml`。

| 平台 | 产物 | 说明 |
|:---:|:---:|:---:|
| Windows | `QzoneArchive-2.0.0-win-x64-setup.exe` | NSIS 安装包, 向导语言包含简体中文与英文 |
| macOS | `QzoneArchive-2.0.0-mac-<架构>.dmg` `QzoneArchive-2.0.0-mac-<架构>.zip` | 架构取打包主机的架构 |
| Linux | `QzoneArchive-2.0.0-linux-<架构>.AppImage` `QzoneArchive-2.0.0-linux-<架构>.deb` | 分类标记为 Utility |

同一目录下的 `release/win-unpacked/`, 即 macOS 的 `release/mac/` 或 `release/mac-arm64/`, Linux 的 `release/linux-unpacked/`, 是不需要安装即可直接运行的应用目录, 方便本地验证。

> 打包产物与开发环境使用同一套数据位置规则: 优先用户目录下的 `.qzonearchive.fork`, 该目录不可写时回退到可执行文件所在目录的同名目录。

## 原理

### 数据来源

归档基于 QQ 空间的**互动列表接口** (`mobile.qzone.qq.com/get_feeds`)。该接口返回当前账号收到的所有互动通知——包括好友发布的新动态、点赞、评论、回复、留言等。程序从中提取原始动态内容并存入本地数据库。

**没有被点赞或评论过的动态无法被恢复**，因为它们不会出现在互动列表中。

### 登录方式

- **二维码登录**：调用 QQ 空间的扫码登录流程，全程不接触密码
- **网页登录**（桌面端）：打开独立窗口加载 QQ 登录页，通过 Electron 会话 Cookie 接口提取登录凭证

登录凭证（Cookie）只保存在主进程内存中，不会写入控制台或日志，也不会经命令接口导出给界面层；为让依赖登录态的窗口（网页登录、独立密码验证、QQ 空间）正常工作，凭证会写进应用会话，会话数据同样位于数据根目录内。

## 注意事项

- 请只归档本人或已获得授权的账号内容
- 归档过程中不要切换 QQ 客户端账号，否则可能有冻结风险
- 出现频繁提示时建议换个时间段继续，程序支持断点续传
- QQ 的视频签名有时效性，过期后需要重新归档以更新视频地址
- 数据保存在用户目录下的 `.qzonearchive.fork` 目录（不可写时回退到应用所在目录的同名目录），建议定期将重要资料额外备份

## 免责声明

本软件是用于整理和备份个人 QQ 空间资料的本地工具，与腾讯公司、QQ、QQ 空间及其关联主体不存在隶属、授权、合作关系。使用者应在合法授权范围内使用，并自行承担使用风险。详见应用内《免责声明与使用须知》。

## 许可证

本仓库沿用上游的 [GPLv3](./LICENSE) 许可证, 本分支 2.0.0 起的桌面端全量重构同样以 GPLv3 授权。
