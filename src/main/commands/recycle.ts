/**
 * 相册回收站与相册命令
 *
 * 本文件只负责 Electron 边界: 独立密码验证窗口的生命周期, pwd2sig 抓取时机, 凭证注入
 * 请求构造与响应解析都在 core/recycle.ts 内实现, 便于普通 Node 下自测
 * 原实现在 Windows 上依赖 WebView2 的 AddWebResourceRequestedFilter 钩子,
 * 这里改为默认会话上的 webRequest.onBeforeRequest, 再用 webContentsId 收敛到本窗口的请求
 */
import { BrowserWindow } from "electron";

import { qzoneAuth } from "../core/login.js";
import {
  PWD2SIG_TITLE_PREFIX,
  captureRecycleSignature,
  clearRecycleSignature,
  createQzoneAlbum,
  listQzoneAlbums,
  listRecycleAlbums,
  listRecyclePhotos,
  loadRecyclePhotoPreview,
  pwd2sigFromPageUrl,
  pwd2sigFromTitle,
  recyclePageUrl,
  recycleSignature,
  recoverRecycleAlbum,
  recoverRecyclePhotos,
  rememberRecycleSignature,
} from "../core/recycle.js";
import { defineCommand } from "../ipc.js";
import { applyCredentialCookies } from "../session.js";

/** 独立密码验证窗口尺寸与标题, 与原 Rust 版 inner_size(960, 720) 及 title 一致 */
const RECYCLE_WINDOW_SIZE = { width: 960, height: 720 };
const RECYCLE_WINDOW_TITLE = "验证 QQ 空间独立密码";

/** 请求过滤范围: 会话级钩子先覆盖全部地址, 再用 webContentsId 收敛到本窗口 */
const RECYCLE_REQUEST_FILTER = { urls: ["*://*/*"] };

/** 注入 Cookie 时使用的地址, 与原 Rust 版 Domain=.qq.com; Path=/ 等价 */
const RECYCLE_COOKIE_URL = "https://user.qzone.qq.com";

/** 原 Rust 版 initialization_script 用的一次性标记, 避免重复点击回收站入口 */
const RECYCLE_OPENED_KEY = "__qzaRecycleOpened";

let recycleWindow: BrowserWindow | null = null;

/** 取仍在使用的验证窗口, 已被用户关闭时返回 null */
function currentWindow(): BrowserWindow | null {
  if (recycleWindow === null || recycleWindow.isDestroyed()) return null;
  return recycleWindow;
}

/**
 * 页面脚本: 发布签名到标题并自动进入回收站
 *
 * 移植自原 Rust 版的 initialization_script, 保留三类动作:
 * 劫持 XHR 与 fetch 采集 pwd2sig, 扫描页面全局与本地存储读取签名, 一次性点击回收站入口
 * 原脚本同时写入顶层窗口标题, 这里只处理本窗口, 因为 Electron 侧只在主框架注入
 */
const BRIDGE_SCRIPT = `(() => {
  if (window.__qzaPwd2sigHooked) return;
  window.__qzaPwd2sigHooked = true;
  const prefix = ${JSON.stringify(PWD2SIG_TITLE_PREFIX)};
  const publish = (token) => {
    if (typeof token !== 'string' || token.length < 5) return;
    document.title = prefix + token;
    try { history.replaceState(null, '', location.pathname + location.search + '#pwd2sig=' + encodeURIComponent(token)); } catch (_) {}
  };
  const capture = (input) => {
    try {
      if (input instanceof FormData || input instanceof URLSearchParams) {
        const token = input.get('pwd2sig'); if (token) publish(String(token));
        return;
      }
      const text = typeof input === 'string' ? input : input && input.url ? input.url : '';
      const match = text.match(/(?:^|[?&])pwd2sig=([^&]+)/i);
      if (match) publish(decodeURIComponent(match[1].replace(/\\+/g, ' ')));
    } catch (_) {}
  };
  try {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) { this.__qzaUrl = String(url || ''); capture(this.__qzaUrl); return originalOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function(body) { capture(this.__qzaUrl); capture(body); return originalSend.apply(this, arguments); };
  } catch (_) {}
  try {
    const originalFetch = window.fetch;
    window.fetch = function(input, init) { capture(input); capture(init && init.body); return originalFetch.apply(this, arguments); };
  } catch (_) {}
  const read = (w) => {
    try {
      const dc = w.QZONE && w.QZONE.dataCenter;
      const token = dc && typeof dc.get === 'function' && dc.get('pwd2sig');
      if (typeof token === 'string' && token.length > 4) return token;
    } catch (_) {}
    try {
      const seen = new WeakSet();
      const scan = (value, depth) => {
        if (!value || depth > 4 || (typeof value !== 'object' && typeof value !== 'function')) return '';
        if (seen.has(value)) return ''; seen.add(value);
        for (const key of Object.keys(value)) {
          let child; try { child = value[key]; } catch (_) { continue; }
          if (key.toLowerCase().includes('pwd2sig') && typeof child === 'string' && child.length > 4) return child;
          const found = scan(child, depth + 1); if (found) return found;
        }
        return '';
      };
      const found = scan(w.QZONE, 0) || scan(w.QPHOTO, 0);
      if (found) return found;
      for (const storage of [w.localStorage, w.sessionStorage]) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i) || ''; const value = storage.getItem(key) || '';
          if (key.toLowerCase().includes('pwd2sig') && value.length > 4) return value;
        }
      }
    } catch (_) {}
    try {
      for (let i = 0; i < w.frames.length; i++) {
        const token = read(w.frames[i]);
        if (token) return token;
      }
    } catch (_) {}
    return '';
  };
  const enterRecycleBin = () => {
    try {
      if (sessionStorage.getItem(${JSON.stringify(RECYCLE_OPENED_KEY)})) return;
      const roots = [document];
      for (const frame of document.querySelectorAll('iframe')) {
        if (frame.contentDocument) roots.push(frame.contentDocument);
      }
      for (const root of roots) {
        for (const node of root.querySelectorAll('*')) {
          if ((node.textContent || '').trim() !== '回收站') continue;
          sessionStorage.setItem(${JSON.stringify(RECYCLE_OPENED_KEY)}, '1');
          const clickable = node.closest('a,button,[role="button"]') || node;
          clickable.click();
          return;
        }
      }
    } catch (_) {}
  };
  const tick = () => {
    const token = read(window);
    if (token) publish(token);
    enterRecycleBin();
  };
  window.__qzaReadPwd2sig = tick;
  setInterval(tick, 800);
  setTimeout(tick, 200);
})();`;

/**
 * 读取脚本: 供 check_recycle_password 主动问一次页面
 *
 * 移植自原 Rust 版 check_recycle_password 里的 eval: 先看地址与已加载资源, 再扫全局与存储,
 * 取到后同样发布到标题; 返回值就是签名原文本, 取不到时返回空串
 */
const READ_SCRIPT = `(() => {
  const prefix = ${JSON.stringify(PWD2SIG_TITLE_PREFIX)};
  const publish = (token) => {
    if (typeof token !== 'string' || token.length < 5) return '';
    document.title = prefix + token;
    try { history.replaceState(null, '', location.pathname + location.search + '#pwd2sig=' + encodeURIComponent(token)); } catch (_) {}
    return token;
  };
  const tokenOf = (value) => {
    const match = String(value || '').match(/(?:^|[?&])pwd2sig=([^&]+)/i);
    if (!match) return '';
    try { return decodeURIComponent(match[1].replace(/\\+/g, ' ')); } catch (_) { return ''; }
  };
  const fromHash = () => {
    try { return new URLSearchParams(location.hash.replace(/^#/, '')).get('pwd2sig') || ''; } catch (_) { return ''; }
  };
  const scanResources = (w) => {
    try {
      for (const entry of w.performance.getEntriesByType('resource')) {
        const token = tokenOf(entry.name); if (token) return publish(token);
      }
      for (let i = 0; i < w.frames.length; i++) {
        const token = scanResources(w.frames[i]); if (token) return token;
      }
    } catch (_) {}
    return '';
  };
  const fromPage = publish(tokenOf(location.href) || fromHash());
  if (fromPage) return fromPage;
  const fromResource = scanResources(window);
  if (fromResource) return fromResource;
  const seen = new WeakSet();
  const findToken = (value, depth) => {
    if (!value || depth > 5 || (typeof value !== 'object' && typeof value !== 'function')) return '';
    if (seen.has(value)) return ''; seen.add(value);
    for (const key of Object.keys(value)) {
      let child; try { child = value[key]; } catch (_) { continue; }
      if (key.toLowerCase().includes('pwd2sig') && typeof child === 'string' && child.length > 4) return child;
      const found = findToken(child, depth + 1); if (found) return found;
    }
    return '';
  };
  let token = '';
  try { token = (window.QZONE && window.QZONE.dataCenter && window.QZONE.dataCenter.get && window.QZONE.dataCenter.get('pwd2sig')) || ''; } catch (_) {}
  try { token = token || (window.QPHOTO && window.QPHOTO.dataCenter && window.QPHOTO.dataCenter.get && window.QPHOTO.dataCenter.get('pwd2sig')) || ''; } catch (_) {}
  token = token || findToken(window.QZONE, 0) || findToken(window.QPHOTO, 0);
  try {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i) || ''; const value = storage.getItem(key) || '';
        if (key.toLowerCase().includes('pwd2sig') && value.length > 4) token = value;
      }
    }
  } catch (_) {}
  return token ? publish(token) : '';
})();`;

/** 参数规整: 原 Tauri 命令的 String 入参在缺省时按空串处理 */
function textArg(value: unknown): string {
  if (typeof value === "string") return value;
  return value === undefined || value === null ? "" : String(value);
}

/** 参数规整: 原 Tauri 命令的 Option<String> 入参缺省时为 undefined */
function optionalTextArg(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return textArg(value);
}

/** 参数规整: 原 Tauri 命令的 Vec<String> 入参 */
function textListArg(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => textArg(item)) : [];
}

export function registerRecycleCommands(): void {
  defineCommand("open_recycle_password_window", async () => {
    const existing = currentWindow();
    if (existing !== null) {
      // 与原基准一致: 窗口已在时只聚焦, 不清空已抓到的签名
      existing.focus();
      return;
    }
    const auth = qzoneAuth();
    clearRecycleSignature();
    const window = new BrowserWindow({
      ...RECYCLE_WINDOW_SIZE,
      title: RECYCLE_WINDOW_TITLE,
      center: true,
      autoHideMenuBar: true,
      // 不指定 partition: 与主窗口共用默认会话, 登录 Cookie 天然可见
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    recycleWindow = window;
    const session = window.webContents.session;
    const webContentsId = window.webContents.id;
    session.webRequest.onBeforeRequest(RECYCLE_REQUEST_FILTER, (details, callback) => {
      if (details.webContentsId === webContentsId) captureRecycleSignature(details.url);
      callback({});
    });
    window.on("closed", () => {
      // 传 null 注销监听: 该会话上本事件同时只允许一个监听, 本模块负责注销自己注册的那个
      session.webRequest.onBeforeRequest(RECYCLE_REQUEST_FILTER, null);
      clearRecycleSignature();
      if (recycleWindow === window) recycleWindow = null;
    });
    window.webContents.on("dom-ready", () => {
      void window.webContents.executeJavaScript(BRIDGE_SCRIPT).catch(() => undefined);
    });
    try {
      await applyCredentialCookies(auth.cookieHeader, {
        session: window.webContents.session,
        url: RECYCLE_COOKIE_URL,
      });
      await window.loadURL(recyclePageUrl(auth.uin));
    } catch (error) {
      window.destroy();
      throw new Error(
        `打开独立密码验证窗口失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  defineCommand("check_recycle_password", async () => {
    const captured = recycleSignature();
    if (captured !== null) return captured;
    const window = currentWindow();
    if (window === null) return null;
    let published: unknown = null;
    try {
      published = await window.webContents.executeJavaScript(READ_SCRIPT);
    } catch {
      published = null;
    }
    if (typeof published === "string" && published.length > 0) {
      rememberRecycleSignature(published);
      return published;
    }
    const fromTitle = pwd2sigFromTitle(window.webContents.getTitle());
    if (fromTitle !== null) {
      rememberRecycleSignature(fromTitle);
      return fromTitle;
    }
    const cookies = await window.webContents.session.cookies.get({ url: RECYCLE_COOKIE_URL });
    const cookie = cookies.find((item) => item.name.toLowerCase() === "pwd2sig");
    if (cookie !== undefined && cookie.value.length > 0) {
      rememberRecycleSignature(cookie.value);
      return cookie.value;
    }
    const fromUrl = pwd2sigFromPageUrl(window.webContents.getURL());
    if (fromUrl !== null) {
      rememberRecycleSignature(fromUrl);
      return fromUrl;
    }
    return null;
  });

  defineCommand("close_recycle_password_window", () => {
    currentWindow()?.close();
  });

  defineCommand("list_recycle_albums", async (args) =>
    await listRecycleAlbums(qzoneAuth(), textArg(args.pwd2sig)),
  );

  defineCommand("list_recycle_photos", async (args) =>
    await listRecyclePhotos(qzoneAuth(), textArg(args.pwd2sig), optionalTextArg(args.albumId)),
  );

  defineCommand("load_recycle_photo_preview", async (args) =>
    await loadRecyclePhotoPreview(qzoneAuth(), textArg(args.imageUrl)),
  );

  defineCommand("list_qzone_albums", async () => await listQzoneAlbums(qzoneAuth()));

  defineCommand("create_qzone_album", async (args) =>
    await createQzoneAlbum(qzoneAuth(), textArg(args.name)),
  );

  defineCommand("recover_recycle_album", async (args) =>
    await recoverRecycleAlbum(qzoneAuth(), textArg(args.pwd2sig), textArg(args.albumId)),
  );

  defineCommand("recover_recycle_photos", async (args) =>
    await recoverRecyclePhotos(
      qzoneAuth(),
      textArg(args.pwd2sig),
      textArg(args.sourceAlbumId),
      textArg(args.targetAlbumId),
      textListArg(args.photoIds),
    ),
  );
}
