/**
 * QQ 登录命令
 *
 * 二维码登录与凭证合并全部在 core/login.ts 中实现; 网页登录需要浏览器窗口与会话 Cookie,
 * 这里把 Electron 侧的实现注入 core 定义的 QzoneWebLoginHost
 */
import { BrowserWindow } from "electron";
import {
  WEB_LOGIN_URL,
  checkWebLogin,
  getLoginStatus,
  logoutQzone,
  openWebLogin,
  pollQrLogin,
  startQrLogin,
  type QzoneWebLoginHost,
} from "../core/login.js";
import { defineCommand } from "../ipc.js";

/** 网页登录窗口尺寸与原 Rust 版 WebviewWindowBuilder 一致 */
const WEB_LOGIN_WINDOW_SIZE = { width: 800, height: 720 };

let webLoginWindow: BrowserWindow | null = null;

/** 取仍在使用的登录窗口, 已被用户关闭时返回 null */
function loginWindow(): BrowserWindow | null {
  if (webLoginWindow === null || webLoginWindow.isDestroyed()) return null;
  return webLoginWindow;
}

function cookieRecord(cookies: { name: string; value: string }[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const cookie of cookies) result[cookie.name] = cookie.value;
  return result;
}

/**
 * 登录窗口与主窗口共用默认会话
 *
 * 因此登录成功后无需再把 Cookie 注入其他窗口, sync_cookies_to_webview 保持空操作
 */
const webLoginHost: QzoneWebLoginHost = {
  isWindowOpen: () => loginWindow() !== null,
  focusWindow: () => {
    loginWindow()?.focus();
  },
  openWindow: async () => {
    const window = new BrowserWindow({
      ...WEB_LOGIN_WINDOW_SIZE,
      title: "QQ 账号登录",
      center: true,
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    webLoginWindow = window;
    window.on("closed", () => {
      if (webLoginWindow === window) webLoginWindow = null;
    });
    try {
      await window.loadURL(WEB_LOGIN_URL);
    } catch (error) {
      webLoginWindow = null;
      window.destroy();
      throw new Error(`创建登录窗口失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
  closeWindow: () => {
    const window = loginWindow();
    webLoginWindow = null;
    window?.close();
  },
  readCookiesForUrl: async (url) => {
    const window = loginWindow();
    if (window === null) return {};
    return cookieRecord(await window.webContents.session.cookies.get({ url }));
  },
  readAllCookies: async () => {
    const window = loginWindow();
    if (window === null) return {};
    return cookieRecord(await window.webContents.session.cookies.get({}));
  },
};

export function registerLoginCommands(): void {
  defineCommand("start_qr_login", () => startQrLogin());
  defineCommand("poll_qr_login", () => pollQrLogin());
  defineCommand("get_login_status", () => getLoginStatus());
  defineCommand("logout_qzone", () => logoutQzone());
  defineCommand("open_web_login", () => openWebLogin(webLoginHost));
  defineCommand("check_web_login", () => checkWebLogin(webLoginHost));
}
