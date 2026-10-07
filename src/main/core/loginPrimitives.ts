/**
 * QQ 登录基础件
 *
 * 作者: JularDepick
 *
 * 无状态的纯函数与纯类型集合: 哈希, 随机 Cookie 值, 移动端 UA 选择, Cookie 解析合并, 回调文本解析
 * 行为基准为 temp/reference/src-tauri/src/qlogin.rs, 算法与错误字符串都与之对齐
 * 本模块不 import 任何模块, 因此可以被系统 Node 直接加载做单测
 */

/** 原 Rust 版使用的一加应用标识 */
export const APP_ID = "549000929";
export const DAID = "5";

/*
 * 移动端 UA 池, 结构沿用原 Rust 版
 * 版本号需保持接近当前主流版本, 腾讯 WAF 会拦截过旧的浏览器版本(HTTP 501)
 */
export const MOBILE_USER_AGENTS: readonly string[] = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 16; Pixel 8 Build/BP2A.250605.031) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 15; SM-S9280 Build/AP3A.240905.015.A2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 15; 23127PN0CC Build/AQ3A.240912.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 15; V2309A Build/AP3A.240905.015.A2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36",
];

/** 与原 Rust 版 login_credentials 的 Cookie 白名单一致 */
const CREDENTIAL_COOKIE_NAMES: readonly string[] = ["uin", "skey", "p_uin", "pt4_token", "p_skey", "pt2gguin"];

const HASH_MASK = 0x7fff_ffff;
const U64_MASK = 0xffff_ffff_ffff_ffffn;
const U128_MASK = (1n << 128n) - 1n;
const HEX_CHARS = "0123456789abcdef";
const ALPHANUM_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * 与 Rust 版 USER_AGENT_SEQUENCE 对应
 *
 * UA 选择会自增该序号, 随机 Cookie 值只读取当前值作为种子
 */
let userAgentSequence = 0;

export type QzoneLoginStatusKind =
  | "waiting"
  | "scanned"
  | "expired"
  | "success"
  | "error"
  | "loggedOut"
  | "webLoginOpened"
  | "webLoginWaiting"
  | "webLoginCancelled";

/** 交给渲染进程的登录凭证, 字段名与原 Rust 版的 serde camelCase 输出一致 */
export interface QzoneLoginCredentials {
  uin: string;
  gTk: number;
  cookies: Record<string, string>;
  userAgent: string;
}

export interface QzoneLoginStatus {
  status: QzoneLoginStatusKind;
  message: string;
  auth: QzoneLoginCredentials | null;
}

/** 一次登录会话的全部内存状态, 只保存在主进程内存中 */
export interface QzoneLoginSession {
  ptqrToken: number;
  cookies: Record<string, string>;
  uin: string | null;
  gTk: number | null;
  userAgent: string;
  loginSig: string;
}

/** 空间接口与归档模块需要的凭证视图 */
export interface QzoneAuth {
  uin: string;
  gTk: number;
  cookieHeader: string;
  userAgent: string;
}

export interface QzoneQrLoginStart {
  qrImage: string;
}

/** 毫秒时间戳, 与原 Rust 版 unix_millis 对应 */
export function unixMillis(): number {
  return Date.now();
}

/** ptqrtoken 计算: 对 qrsig 做 5 位左移累加, 取低 31 位 */
export function ptqrToken(qrsig: string): number {
  let value = 0;
  for (const character of qrsig) {
    const code = character.codePointAt(0) ?? 0;
    value = (value + ((value << 5) >>> 0) + code) >>> 0;
  }
  return value & HASH_MASK;
}

/** bkn 计算: 以 5381 为初值的 5 位左移累加, 取低 31 位 */
export function bkn(pSkey: string): number {
  let value = 5381;
  for (const character of pSkey) {
    const code = character.codePointAt(0) ?? 0;
    value = (value + ((value << 5) >>> 0) + code) >>> 0;
  }
  return value & HASH_MASK;
}

/**
 * 从 ptuiCB 回调文本中取查询参数
 *
 * 原 Rust 版正则: (?:[?&]|')name=([^&']+)
 */
export function callbackQueryValue(text: string, name: string): string | null {
  const matched = new RegExp(`(?:[?&]|')${name}=([^&']+)`).exec(text);
  return matched === null ? null : matched[1];
}

/** 从回调文本中取出第 3 个单引号参数, 仅当首参为 0 时视为登录跳转地址 */
export function pollLoginUrl(text: string): string | null {
  const values: string[] = [];
  const pattern = /'([^']*)'/g;
  let matched = pattern.exec(text);
  while (matched !== null) {
    values.push(matched[1]);
    matched = pattern.exec(text);
  }
  return values.length >= 3 && values[0] === "0" ? values[2] : null;
}

/** 去掉 uin 前缀的 o 与前导 0, 与原 Rust 版 normalized_uin 一致 */
export function normalizedUin(value: string): string {
  return value.replace(/^o+/, "").replace(/^0+/, "");
}

/** 推进一次 128 位线性同余状态 */
function nextRandomState(state: bigint): bigint {
  return (state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) & U128_MASK;
}

/** 生成随机值初始状态, 种子由毫秒时间戳与当前 UA 序号异或得到 */
function initialRandomState(multiplier: bigint): bigint {
  return ((BigInt(unixMillis()) ^ BigInt(userAgentSequence)) * multiplier) & U128_MASK;
}

/** 随机十六进制串, 用于 _qimei_* 与 ptcz 一类指纹 Cookie */
export function randomHex(length: number): string {
  let state = initialRandomState(0x9e37_79b9n);
  let result = "";
  for (let index = 0; index < length; index += 1) {
    state = nextRandomState(state);
    result += HEX_CHARS[Number((state >> 32n) & 0xfn)];
  }
  return result;
}

/** 随机大小写字母加数字混合串, 用于需要全字符集的 Cookie (如 RK) */
export function randomAlphanum(length: number): string {
  let state = initialRandomState(0x9e37_79b9n);
  let result = "";
  for (let index = 0; index < length; index += 1) {
    state = nextRandomState(state);
    result += ALPHANUM_CHARS[Number((state >> 32n) % BigInt(ALPHANUM_CHARS.length))];
  }
  return result;
}

/**
 * 选择移动端 UA
 *
 * 种子由毫秒时间戳与自增序号混合, 并避免与上一次选中的 UA 相同
 */
export function selectMobileUserAgent(previous: string | null): string {
  const sequence = userAgentSequence;
  userAgentSequence += 1;
  const seed = BigInt(unixMillis()) ^ ((BigInt(sequence) * 0x9e37_79b1n) & U64_MASK);
  let index = Number(seed % BigInt(MOBILE_USER_AGENTS.length));
  if (previous !== null && previous === MOBILE_USER_AGENTS[index]) index = (index + 1) % MOBILE_USER_AGENTS.length;
  return MOBILE_USER_AGENTS[index];
}

/** 按 uin 的 UTF-8 字节做 31 进制散列, 决定账号固定使用的 UA */
export function accountUserAgent(uin: string): string {
  let hash = 0;
  for (const byte of new TextEncoder().encode(uin)) {
    hash = (hash * 31 + byte) >>> 0;
  }
  return MOBILE_USER_AGENTS[hash % MOBILE_USER_AGENTS.length];
}

/** 拆分单条 Set-Cookie, 名称与值都保持原文 */
function splitSetCookie(header: string): { name: string; value: string } | null {
  const separator = header.indexOf("=");
  if (separator <= 0) return null;
  const rest = header.slice(separator + 1);
  const end = rest.indexOf(";");
  return { name: header.slice(0, separator), value: end < 0 ? rest : rest.slice(0, end) };
}

/** 解析单条 Set-Cookie, 返回裁剪过名称的键值对, 名称缺失时返回 null */
export function parseSetCookie(header: string): { name: string; value: string } | null {
  const parts = splitSetCookie(header);
  if (parts === null) return null;
  const name = parts.name.trim();
  return name.length === 0 ? null : { name, value: parts.value };
}

/** 取第一条指定名称的 Set-Cookie 原文值, 与 Rust 的 find 语义一致 */
export function readSetCookieValue(headers: readonly string[], name: string): string | null {
  for (const header of headers) {
    const cookie = parseSetCookie(header);
    if (cookie !== null && cookie.name === name) return cookie.value;
  }
  return null;
}

/**
 * 合并响应 Set-Cookie
 *
 * QQ 的响应可能同时带有清理旧 Cookie 的空值, 不能让它覆盖本次登录得到的有效值
 */
export function mergeSetCookies(headers: readonly string[], cookies: Record<string, string>): void {
  for (const header of headers) {
    const cookie = parseSetCookie(header);
    if (cookie === null) continue;
    const value = cookie.value.trim();
    if (value.length > 0) cookies[cookie.name] = value;
  }
}

/** 拼接请求 Cookie 头, 与原 Rust 版 cookie_header 一致 */
export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/** 按键是否存在读取 Cookie 原文, 与 Rust 的 HashMap::get 语义一致 */
export function cookieValue(cookies: Record<string, string>, name: string): string | null {
  return Object.hasOwn(cookies, name) ? cookies[name] : null;
}

/** 只导出白名单内的非空 Cookie, 与原 Rust 版 login_credentials 一致 */
export function loginCredentials(session: QzoneLoginSession): QzoneLoginCredentials | null {
  if (session.uin === null || session.gTk === null) return null;
  const cookies: Record<string, string> = {};
  for (const [name, value] of Object.entries(session.cookies)) {
    if (CREDENTIAL_COOKIE_NAMES.includes(name) && value.length > 0) cookies[name] = value;
  }
  return { uin: session.uin, gTk: session.gTk, cookies, userAgent: session.userAgent };
}
