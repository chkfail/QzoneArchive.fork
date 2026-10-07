<div align="center">

# QzoneArchive

[![Version](https://img.shields.io/badge/Version-2.0.0-red)](https://github.com/chkfail/QzoneArchive.fork)
[![License](https://img.shields.io/badge/License-GPLv3-yellow)](./LICENSE)

[English] |
[简体中文](./README.md)

</div>

---

A desktop tool that archives QQ Zone posts, photos, videos and interactions to local storage, PC only.

> [!CAUTION]
> **Software from outside this repository has recently caused account credential leaks. Verify the source of any build carefully. Nothing except what this repository publishes can be trusted; do not download or run it.**

> This project is a fork of https://github.com/Gaoshu705/QzoneArchive

## Features

- **Complete archiving**: restores original post text, images, videos and comments, grouped into own posts, friends' posts and guestbook entries
- **Resumable**: continues from the last position after an interruption, already archived content is kept
- **Rate protection**: at most 300 pages per 10 minutes, pauses safely when throttled and resumes after the countdown
- **Interaction recovery**: shows who liked each post and the comment threads, with an interaction ranking
- **Local storage**: everything is stored in SQLite under `.qzonearchive.fork` in your home directory, falling back to a directory of the same name next to the application when that location is not writable; nothing is uploaded to any server
- **HTML export**: exports a category or a selection to a standalone HTML file for offline browsing
- **Media timeline**: browses archived photos and videos by year, videos are cached on demand
- **Dark mode**: follows the system or can be toggled manually
- **PC only**: Windows (primary), Linux and macOS desktop

## Screenshots

| Dashboard | Archive |
|--------|----------|
| ![Dashboard](public/runtime/仪表盘.png) | ![Archive](public/runtime/归档内容.png) |

| Media timeline | Archive tasks |
|-----------|----------|
| ![Media timeline](public/runtime/媒体时光轴.png) | ![Archive tasks](public/runtime/归档任务.png) |

## Tech stack

| Layer | Technology |
|---|------|
| Desktop shell | Electron 44 |
| Frontend | Vue 3 + TypeScript + Vite |
| UI components | PrimeVue 4 |
| State management | Pinia |
| Local database | SQLite (node:sqlite) |
| HTTP client | Node global fetch (undici) |
| Packaging | electron-builder |

## Repository layout

```
QzoneArchive.fork/
├── .github/
│   ├── ISSUE_TEMPLATE/         # Issue templates
│   └── workflows/              # Quality checks, docs deployment, release packaging
├── build/                      # Packaging icons (ico, icns and png size set)
├── public/                     # README screenshots
├── scripts/                    # Development and self-check scripts
├── site/                       # VitePress documentation site
├── src/
│   ├── main/                   # Electron main process
│   │   ├── commands/           # Command implementations (one file per domain)
│   │   ├── core/               # Business core (plain Node, no Electron dependency)
│   │   ├── index.ts            # Main process entry
│   │   ├── ipc.ts              # Command routing
│   │   ├── paths.ts            # Data root resolution and boundary checks
│   │   └── protocol.ts         # qza:// local file protocol
│   ├── preload/                # Bridge injection
│   ├── renderer/               # Vue frontend
│   │   ├── components/         # Shared components
│   │   ├── layouts/            # Application shell
│   │   ├── router/             # Route table
│   │   ├── stores/             # Pinia state
│   │   ├── styles/             # Global styles
│   │   ├── utils/              # Helpers and backend command wrappers
│   │   └── views/              # Page components
│   └── shared/                 # Bridge contract and shared types
├── COPYRIGHT                   # Copyright and license notes
├── LICENSE                     # GPLv3 license
├── README.md                   # Chinese documentation (primary)
├── README_en-US.md             # English documentation
├── electron-builder.yml        # Packaging configuration
├── package.json                # Dependencies and scripts
└── vite.config.ts              # Frontend build configuration
```

## Development

### Requirements

- [Node.js](https://nodejs.org/) 20+
- No extra runtime: the application ships Electron and its Chromium engine, so Windows no longer needs the system WebView2

### Start the development environment

```bash
# Install dependencies (downloads the Electron binary as well)
npm install

# Start the development environment (Vite dev server, main process build, application window)
npm run dev

# Start the frontend dev server only
npm run dev:renderer
```

### Build

```bash
# Type check (renderer + main process)
npm run typecheck

# Full build (main process + renderer)
npm run build

# Core logic self-check (feed cursor parsing and archive database state layer)
npm run selftest

# Startup self-check (launches the app, checks the bridge, page mounting and a batch of real commands)
npm run smoke
```

### Packaging

Packaging uses electron-builder with the configuration in `electron-builder.yml`, and writes artifacts to `release/`. Each script runs a full build first:

```bash
# Windows: NSIS installer, per-user installation, no administrator rights required
npm run package:win

# macOS: disk image and zip archive
npm run package:mac

# Linux: AppImage and deb package
npm run package:linux
```

Packages contain only `dist/electron/`, `dist/renderer/` and `package.json`, archived as asar inside `resources/app.asar`, without `node_modules`. Icons live in `build/`; installer and per-platform settings are in `electron-builder.yml`.

| Platform | Artifacts | Notes |
|:---:|:---:|:---:|
| Windows | `QzoneArchive-2.0.0-win-x64-setup.exe` | NSIS installer, wizard languages include Simplified Chinese and English |
| macOS | `QzoneArchive-2.0.0-mac-<arch>.dmg` `QzoneArchive-2.0.0-mac-<arch>.zip` | Architecture follows the packaging host |
| Linux | `QzoneArchive-2.0.0-linux-<arch>.AppImage` `QzoneArchive-2.0.0-linux-<arch>.deb` | Category is marked as Utility |

The sibling `release/win-unpacked/` directory, or `release/mac/`, `release/mac-arm64/` on macOS and `release/linux-unpacked/` on Linux, is an unpacked application directory that runs without installation and is convenient for local verification.

> Packaged builds follow the same data location rule as development: `.qzonearchive.fork` in your home directory first, falling back to a directory of the same name next to the executable when that location is not writable.

## How it works

### Data source

Archiving uses the QQ Zone **interaction feed API** (`mobile.qzone.qq.com/get_feeds`). That endpoint returns every interaction notification the account has received, including friends' new posts, likes, comments, replies and guestbook entries. The application extracts the original post content from it and stores it in the local database.

**Posts that were never liked or commented on cannot be recovered**, because they never appear in the interaction feed.

### Sign-in

- **QR code sign-in**: follows the QQ Zone QR flow and never touches the password
- **Web sign-in** (desktop): opens a separate window on the QQ sign-in page and reads the credentials through the Electron session cookie API

Credentials (cookies) are kept in main process memory only. They are never written to the console or logs, and are never exported to the renderer through a command; so that windows that depend on a signed-in state (web sign-in, the standalone password verification window, QQ Zone) keep working, the credentials are written into the application session, whose data also lives inside the data root.

## Notes

- Archive only your own account or accounts you are explicitly authorized to archive
- Do not switch QQ client accounts while archiving, otherwise the account may be frozen
- When throttling messages appear, continue in another time window; the application supports resuming
- QQ video signatures expire, so re-archive to refresh the video URL
- Data is stored in `.qzonearchive.fork` in your home directory, falling back to a directory of the same name next to the application; back up important material regularly

## Disclaimer

This software is a local tool for organising and backing up personal QQ Zone material. It is not affiliated with, authorized by, or partnered with Tencent, QQ, QQ Zone or any related entity. Use it within the scope of what you are legally authorized to do and at your own risk. See the in-app Disclaimer and usage notice for details.

## License

This repository keeps the upstream [GPLv3](./LICENSE) license, and the desktop rewrite on this branch since 2.0.0 is licensed under the same terms.
