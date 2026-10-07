/**
 * QQ 登录核心逻辑
 *
 * 行为基准为 temp/reference/src-tauri/src/qlogin.rs: 接口地址, 查询参数, Cookie 名称,
 * 状态机分支, UA 选择策略, bkn 与 ptqrtoken 计算, 错误字符串都与之对齐
 * 登录凭证只保存在本模块的内存变量中, 不落盘, 不写日志, 任何日志位置都不得出现 Cookie 原文
 * 本模块禁止 import electron; 网页登录所需的浏览器窗口通过 QzoneWebLoginHost 注入
 */
import { fetchRemoteBytes, fetchRemoteText, type RemoteResponseDetails } from "../net.js";
import {
  APP_ID,
  DAID,
  accountUserAgent,
  bkn,
  callbackQueryValue,
  cookieHeader,
  cookieValue,
  loginCredentials,
  mergeSetCookies,
  normalizedUin,
  pollLoginUrl,
  ptqrToken,
  randomAlphanum,
  randomHex,
  readSetCookieValue,
  selectMobileUserAgent,
  unixMillis,
  type QzoneAuth,
  type QzoneLoginSession,
  type QzoneLoginStatus,
  type QzoneQrLoginStart,
} from "./loginPrimitives.js";

/** 纯函数与共享类型同属登录模块的对外接口, 一并导出, 便于复用与单测 */
export * from "./loginPrimitives.js";

const S_URL = "https://h5.qzone.qq.com/mqzone/index";
const PROXY_URL = "";
const XLOGIN_URL = "https://xui.ptlogin2.qq.com/cgi-bin/xlogin";
const PTQRSHOW_URL = "https://ssl.ptlogin2.qq.com/ptqrshow";
const PTQRLOGIN_URL = "https://ssl.ptlogin2.qq.com/ptqrlogin";
const CHECK_SIG_URL = "https://ptlogin2.qzone.qq.com/check_sig";

/** 网页登录入口, 由 Electron 侧负责加载 */
export const WEB_LOGIN_URL = "https://i.qq.com";

/** 唯一的内存登录会话, 退出登录时置空 */
let session: QzoneLoginSession | null = null;

/** 上一次为二维码登录选中的 UA, 用于避免连续两次相同 */
let lastUserAgent: string | null = null;

/**
 * 网页登录所需的外部能力
 *
 * 由 Electron 侧实现: BrowserWindow 负责承载登录页, session.cookies 负责读取凭证
 */
export interface QzoneWebLoginHost {
  /** 登录窗口是否仍然存在 */
  isWindowOpen(): boolean;
  /** 聚焦已存在的登录窗口 */
  focusWindow(): void;
  /** 新建登录窗口并加载登录页 */
  openWindow(): Promise<void>;
  /** 关闭登录窗口 */
  closeWindow(): void;
  /** 读取与指定地址匹配的 Cookie */
  readCookiesForUrl(url: string): Promise<Record<string, string>>;
  /** 读取会话内全部 Cookie, 作为 p_skey 兜底 */
  readAllCookies(): Promise<Record<string, string>>;
}

/** 网络异常统一转成短描述, 不携带任何 Cookie */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 拼接查询串, 编码方式与 Rust 版 reqwest 的 query 序列化一致 */
function withQuery(base: string, params: [string, string][]): string {
  return `${base}?${new URLSearchParams(params).toString()}`;
}

function xloginUrl(): string {
  return withQuery(XLOGIN_URL, [
    ["hide_title_bar", "1"],
    ["style", "22"],
    ["daid", DAID],
    ["low_login", "0"],
    ["qlogin_auto_login", "1"],
    ["no_verifyimg", "1"],
    ["link_target", "blank"],
    ["appid", APP_ID],
    ["target", "self"],
    ["s_url", S_URL],
    ["proxy_url", PROXY_URL],
    ["pt_no_auth", "1"],
  ]);
}

function ptqrshowUrl(): string {
  return withQuery(PTQRSHOW_URL, [
    ["appid", APP_ID],
    ["e", "2"],
    ["l", "M"],
    ["s", "3"],
    ["d", "72"],
    ["v", "4"],
    ["t", String(unixMillis())],
    ["daid", DAID],
    ["pt_3rd_aid", "0"],
    ["u1", S_URL],
  ]);
}

function ptqrloginUrl(current: QzoneLoginSession): string {
  return withQuery(PTQRLOGIN_URL, [
    ["u1", S_URL],
    ["ptqrtoken", String(current.ptqrToken)],
    ["ptredirect", "0"],
    ["h", "1"],
    ["t", "1"],
    ["g", "1"],
    ["from_ui", "1"],
    ["ptlang", "2052"],
    ["action", `0-0-${unixMillis()}`],
    ["js_ver", "20032614"],
    ["js_type", "1"],
    ["login_sig", current.loginSig],
    ["pt_uistyle", "40"],
    ["has_onekey", "1"],
    ["o1vId", ""],
    ["aid", APP_ID],
    ["daid", DAID],
  ]);
}

/** 回调文本里没有跳转地址时的兜底 check_sig 地址, 参数与原 Rust 版逐字一致 */
function fallbackCheckSigUrl(text: string): string {
  const ptsigx = callbackQueryValue(text, "ptsigx") ?? "";
  const uin = callbackQueryValue(text, "uin") ?? "";
  return `${CHECK_SIG_URL}?pttype=1&uin=${uin}&service=ptqrlogin&nodirect=0&ptsigx=${ptsigx}&s_url=${S_URL}&f_url=&ptlang=2052&ptredirect=100&aid=${APP_ID}&daid=${DAID}`;
}

/** 关闭自动跳转的文本请求, 失败时抛出与基准一致的前缀 */
async function requestTextOrFail(
  url: string,
  headers: Record<string, string>,
  failurePrefix: string,
): Promise<QzaRemoteFetchTextResult & RemoteResponseDetails> {
  try {
    return await fetchRemoteText(url, { headers }, { redirect: "manual" });
  } catch (error) {
    throw new Error(`${failurePrefix}${describeError(error)}`);
  }
}

/** 关闭自动跳转的二进制请求, 失败时抛出与基准一致的前缀 */
async function requestBytesOrFail(
  url: string,
  headers: Record<string, string>,
  failurePrefix: string,
): Promise<QzaRemoteFetchBytesResult & RemoteResponseDetails> {
  try {
    return await fetchRemoteBytes(url, { headers }, { redirect: "manual" });
  } catch (error) {
    throw new Error(`${failurePrefix}${describeError(error)}`);
  }
}

/** 依次选择移动端 UA, 避免与上一次重复 */
function nextMobileUserAgent(): string {
  const selected = selectMobileUserAgent(lastUserAgent);
  lastUserAgent = selected;
  return selected;
}

/** 与 Rust 的 HashMap::entry().or_insert 对应, 键已存在时保留原值 */
function insertCookieIfAbsent(cookies: Record<string, string>, name: string, value: string): void {
  if (!Object.hasOwn(cookies, name)) cookies[name] = value;
}

interface LoginSigResult {
  loginSig: string;
  cookies: Record<string, string>;
}

/** 取 pt_login_sig, 该 Cookie 只作为 login_sig 参数使用, 不并入会话 Cookie */
async function fetchLoginSig(userAgent: string): Promise<LoginSigResult> {
  const response = await requestTextOrFail(xloginUrl(), { "User-Agent": userAgent }, "xlogin 请求失败: ");
  if (!response.ok) throw new Error(`xlogin 返回 HTTP ${response.status}`);
  const cookies: Record<string, string> = {};
  mergeSetCookies(response.setCookie, cookies);
  const loginSig = cookieValue(cookies, "pt_login_sig");
  if (loginSig === null) throw new Error("xlogin 响应中缺少 pt_login_sig cookie");
  delete cookies["pt_login_sig"];
  return { loginSig, cookies };
}

/** 补齐移动端指纹与浏览器追踪 Cookie, 插入顺序与原 Rust 版一致 */
function applyQrFingerprintCookies(cookies: Record<string, string>): void {
  cookies["_qimei_fingerprint"] = randomHex(32);
  cookies["_qimei_uuid42"] = randomHex(42);
  cookies["_qimei_i_3"] = randomHex(87);
  cookies["_qimei_h38"] = `${randomHex(25)}0${randomHex(12)}`;
  cookies["_qimei_i_1"] = randomHex(97);
  cookies["_qpsvr_localtk"] = (unixMillis() / 1e18).toFixed(16);
  insertCookieIfAbsent(cookies, "RK", randomAlphanum(10));
  insertCookieIfAbsent(cookies, "ptcz", randomHex(64));
  const timestamp = unixMillis();
  insertCookieIfAbsent(cookies, "pgv_pvid", String((timestamp % 9_000_000_000) + 1_000_000_000));
  insertCookieIfAbsent(cookies, "pgv_info", `ssid=s${timestamp}`);
  insertCookieIfAbsent(cookies, "QZ_FE_WEBP_SUPPORT", "1");
  insertCookieIfAbsent(cookies, "cpu_performance_v8", "0");
  insertCookieIfAbsent(cookies, "__Q_w_s_hat_seed", "1");
  insertCookieIfAbsent(cookies, "domainid", "5");
  insertCookieIfAbsent(cookies, "fqm_pvqid", randomUuidLike());
  insertCookieIfAbsent(cookies, "fqm_sessionid", randomUuidLike());
}

/** 形如 UUID 的随机串, 用于 fqm 系列 Cookie */
function randomUuidLike(): string {
  return `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}`;
}

/**
 * 登录成功后访问 QQ 空间 H5 首页, 收集追踪 Cookie 并设置用户标识
 *
 * 预热失败只影响后续请求的追踪 Cookie, 不阻断登录
 */
async function warmupQzoneSession(cookies: Record<string, string>, userAgent: string, uin: string): Promise<void> {
  try {
    const response = await fetchRemoteText(
      S_URL,
      { headers: { "User-Agent": userAgent, Cookie: cookieHeader(cookies) } },
      { redirect: "manual" },
    );
    if (response.status >= 200 && response.status < 400) mergeSetCookies(response.setCookie, cookies);
  } catch {
    // 预热请求失败按原基准忽略
  }
  // 用户标识 Cookie 正常由浏览器端 JS 设置
  insertCookieIfAbsent(cookies, "ptui_loginuin", uin);
  insertCookieIfAbsent(cookies, "QZ_FE_WEBP_SUPPORT", "1");
  insertCookieIfAbsent(cookies, "cpu_performance_v8", "0");
  insertCookieIfAbsent(cookies, "__Q_w_s_hat_seed", "1");
  insertCookieIfAbsent(cookies, "domainid", "5");
}

/** 取二维码登录所需的凭证, 供后续空间接口与归档模块复用 */
export function qzoneAuth(): QzoneAuth {
  if (session === null) throw new Error("尚未登录 QQ 空间");
  if (session.gTk === null) throw new Error("登录会话缺少 g_tk");
  const pSkey = cookieValue(session.cookies, "p_skey");
  if (pSkey === null || pSkey.trim().length === 0) throw new Error("登录会话缺少有效的 p_skey");
  if (session.uin === null) throw new Error("登录会话缺少 uin");
  return {
    uin: session.uin,
    gTk: session.gTk,
    cookieHeader: cookieHeader(session.cookies),
    userAgent: session.userAgent,
  };
}

/** 对应原命令 start_qr_login: 取 pt_login_sig, 再取二维码图片与 qrsig */
export async function startQrLogin(): Promise<QzoneQrLoginStart> {
  const userAgent = nextMobileUserAgent();
  const { loginSig, cookies } = await fetchLoginSig(userAgent);
  const response = await requestBytesOrFail(
    ptqrshowUrl(),
    { "User-Agent": userAgent, Cookie: cookieHeader(cookies) },
    "获取登录二维码失败：",
  );
  if (!response.ok) throw new Error(`获取登录二维码失败：HTTP ${response.status}`);
  const qrsig = readSetCookieValue(response.setCookie, "qrsig");
  if (qrsig === null) throw new Error("二维码响应中缺少 qrsig");
  mergeSetCookies(response.setCookie, cookies);
  applyQrFingerprintCookies(cookies);
  session = { ptqrToken: ptqrToken(qrsig), cookies, uin: null, gTk: null, userAgent, loginSig };
  return { qrImage: `data:image/png;base64,${response.bytesBase64}` };
}

/** 对应原命令 poll_qr_login: 判定 66/67/65/0, 成功后经 check_sig 换 p_skey */
export async function pollQrLogin(): Promise<QzoneLoginStatus> {
  if (session === null) throw new Error("请先获取登录二维码");
  const current = session;
  const response = await requestTextOrFail(
    ptqrloginUrl(current),
    { "User-Agent": current.userAgent, Cookie: cookieHeader(current.cookies) },
    "检查扫码状态失败：",
  );
  mergeSetCookies(response.setCookie, current.cookies);
  const text = response.text;

  if (text.includes("'66'") || text.includes("二维码未失效")) {
    return { status: "waiting", message: "请使用手机 QQ 扫描二维码", auth: null };
  }
  if (text.includes("'67'") || text.includes("二维码认证中")) {
    return { status: "scanned", message: "已扫码，请在手机上确认登录", auth: null };
  }
  if (text.includes("'65'") || text.includes("二维码已失效")) {
    return { status: "expired", message: "二维码已失效，请刷新后重试", auth: null };
  }
  if (!text.includes("'0'") && !text.includes("登录成功")) {
    return { status: "error", message: "QQ 登录返回了无法识别的状态", auth: null };
  }

  const loginUrl = pollLoginUrl(text) ?? fallbackCheckSigUrl(text);
  const callbackUin = callbackQueryValue(text, "uin");
  if (callbackUin === null) throw new Error("登录成功响应中缺少 uin");

  const confirm = await requestTextOrFail(
    loginUrl,
    { "User-Agent": current.userAgent, Cookie: cookieHeader(current.cookies) },
    "确认 QQ 登录失败：",
  );
  mergeSetCookies(confirm.setCookie, current.cookies);

  const uin = normalizedUin(callbackUin);
  const pSkey = cookieValue(current.cookies, "p_skey");
  if (pSkey === null || pSkey.trim().length === 0) {
    const available = Object.entries(current.cookies)
      .filter(([, value]) => value.trim().length > 0)
      .map(([name]) => name)
      .join(", ");
    throw new Error(`登录 Cookie 中缺少有效的 p_skey（当前 Cookie：${available}）`);
  }
  current.gTk = bkn(pSkey);
  current.uin = uin;
  current.userAgent = accountUserAgent(uin);
  await warmupQzoneSession(current.cookies, current.userAgent, uin);

  const auth = loginCredentials(current);
  if (auth === null) throw new Error("登录凭证不完整");
  return { status: "success", message: "登录成功", auth };
}

/** 对应原命令 get_login_status */
export function getLoginStatus(): QzoneLoginStatus {
  if (session !== null) {
    const auth = loginCredentials(session);
    if (auth !== null) return { status: "success", message: "已登录", auth };
  }
  return { status: "loggedOut", message: "尚未登录", auth: null };
}

/** 对应原命令 logout_qzone */
export function logoutQzone(): void {
  session = null;
}

/** 对应原命令 open_web_login: 窗口已存在则聚焦, 否则新建 */
export async function openWebLogin(host: QzoneWebLoginHost): Promise<QzoneLoginStatus> {
  if (host.isWindowOpen()) {
    host.focusWindow();
    return { status: "webLoginOpened", message: "登录窗口已打开，请在窗口中完成 QQ 登录", auth: null };
  }
  await host.openWindow();
  return { status: "webLoginOpened", message: "请在打开的窗口中完成 QQ 登录", auth: null };
}

/**
 * 对应原命令 check_web_login: 从浏览器会话提取凭证并预热
 *
 * 窗口已关闭时返回 webLoginCancelled, 尚未检测到 p_skey 时返回 webLoginWaiting
 */
export async function checkWebLogin(host: QzoneWebLoginHost): Promise<QzoneLoginStatus> {
  if (!host.isWindowOpen()) {
    return { status: "webLoginCancelled", message: "登录窗口已关闭", auth: null };
  }

  const cookies = await host.readCookiesForUrl(WEB_LOGIN_URL);
  const scopedPSkey = cookieValue(cookies, "p_skey");
  // 地址维度的 Cookie 没拿到 p_skey 时, 用会话内全部 Cookie 兜底补齐
  if (scopedPSkey === null || scopedPSkey.length === 0) {
    for (const [name, value] of Object.entries(await host.readAllCookies())) {
      if (!Object.hasOwn(cookies, name)) cookies[name] = value;
    }
  }

  const pSkey = cookieValue(cookies, "p_skey");
  if (pSkey === null || pSkey.length === 0) {
    return { status: "webLoginWaiting", message: "等待登录完成…", auth: null };
  }

  const rawUin = cookieValue(cookies, "uin") ?? cookieValue(cookies, "p_uin");
  if (rawUin === null || rawUin.length === 0) {
    throw new Error(`登录 Cookie 不完整：缺少 uin（当前可用 Cookie：${Object.keys(cookies).join(", ")}）`);
  }

  const gTk = bkn(pSkey);
  const userAgent = accountUserAgent(rawUin);
  const uin = normalizedUin(rawUin);
  await warmupQzoneSession(cookies, userAgent, uin);

  const next: QzoneLoginSession = { ptqrToken: 0, cookies, uin, gTk, userAgent, loginSig: "" };
  const auth = loginCredentials(next);
  if (auth === null) throw new Error("登录凭证不完整");
  host.closeWindow();
  session = next;
  return { status: "success", message: "登录成功", auth };
}
