/**
 * QQ 空间相册回收站与相册接口
 *
 * 行为基准为 temp/reference/src-tauri/src/qzone.rs 的回收站与相册部分:
 * 接口地址, 查询参数与表单字段顺序, 请求头, 错误字符串都与之逐项对齐
 * 本模块是纯 Node 层, 禁止 import electron: 凭证由调用方注入, 独立密码签名只留在进程内存
 * 原实现用 Windows 专属的 WebView2 钩子抓取 pwd2sig, 这里改为从请求地址中提取,
 * 提取函数与签名状态都在本模块内, 便于脱离 Electron 自测
 */
import { STATUS_CODES } from "node:http";

import { fetchRemoteBytes, fetchRemoteText } from "../net.js";
import type { QzoneAuth } from "./loginPrimitives.js";
import { unixMillis } from "./loginPrimitives.js";
import { ensureQzoneSuccess, parseQzoneJson } from "./qzoneClient.js";

/** 回收站与相册接口共用的代理前缀, 与原 Rust 版各接口地址的前半段一致 */
const QZONE_CGI_PREFIX = "https://user.qzone.qq.com/proxy/domain/photo.qzone.qq.com/cgi-bin/common";

/** 回收站相册列表接口地址, 对应 Rust 版 RECYCLE_ALBUM_LIST_URL */
export const RECYCLE_ALBUM_LIST_URL = `${QZONE_CGI_PREFIX}/cgi_alist_recycle_v2`;

/** 回收站照片列表接口地址, 对应 Rust 版 RECYCLE_PHOTO_LIST_URL */
export const RECYCLE_PHOTO_LIST_URL = `${QZONE_CGI_PREFIX}/cgi_plist_recycle_v2`;

/** 恢复照片接口地址, 对应 Rust 版 RECOVER_PHOTO_URL */
export const RECOVER_RECYCLE_PHOTO_URL = `${QZONE_CGI_PREFIX}/cgi_recover_pic_v2`;

/** 恢复相册接口地址, 对应 Rust 版 RECOVER_ALBUM_URL */
export const RECOVER_RECYCLE_ALBUM_URL = `${QZONE_CGI_PREFIX}/cgi_recover_album_v2`;

/** 相册列表接口地址, 对应 Rust 版 ALBUM_LIST_URL */
export const QZONE_ALBUM_LIST_URL =
  "https://h5.qzone.qq.com/proxy/domain/photo.qzone.qq.com/fcgi-bin/fcg_list_album_v3";

/** 创建相册接口地址, 对应 Rust 版 CREATE_ALBUM_URL */
export const CREATE_QZONE_ALBUM_URL = `${QZONE_CGI_PREFIX}/cgi_add_album_v2`;

/**
 * 回收站照片列表的地址标记
 *
 * 原 WebView2 钩子只认包含该片段的请求, 提取签名前必须先命中它
 */
export const RECYCLE_PHOTO_LIST_MARKER = "cgi_plist_recycle_v2";

/** 缩略图地址允许的域名后缀, 对应 Rust 版 load_recycle_photo_preview 的域名白名单 */
export const QQ_IMAGE_HOST_SUFFIXES: readonly string[] = ["qq.com", "qpic.cn"];

/** 独立密码签名在页面标题中的前缀, 与原 Rust 版 initialization_script 的约定一致 */
export const PWD2SIG_TITLE_PREFIX = "__QZA_PWD2SIG__";

/** 接口地址集合, 可整体覆盖以便离线自测指向本地服务器 */
export interface RecycleEndpoints {
  recycleAlbumList: string;
  recyclePhotoList: string;
  recoverAlbum: string;
  recoverPhotos: string;
  albumList: string;
  createAlbum: string;
}

/** 线上接口地址, 各请求函数的缺省取值 */
export const QZONE_RECYCLE_ENDPOINTS: RecycleEndpoints = {
  recycleAlbumList: RECYCLE_ALBUM_LIST_URL,
  recyclePhotoList: RECYCLE_PHOTO_LIST_URL,
  recoverAlbum: RECOVER_RECYCLE_ALBUM_URL,
  recoverPhotos: RECOVER_RECYCLE_PHOTO_URL,
  albumList: QZONE_ALBUM_LIST_URL,
  createAlbum: CREATE_QZONE_ALBUM_URL,
};

/** 查询串或表单字段, 数组顺序即序列化顺序 */
export type QzoneFormField = readonly [string, string];

/** 请求表单与查询串统一使用的类型 */
const URLENCODED_CONTENT_TYPE = "application/x-www-form-urlencoded;charset=UTF-8";

/** 请求语言头, 与原 Rust 版逐字一致 */
const ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6,zh-TW;q=0.5";

/** 回收站与相册接口使用的来源站 */
const QZONE_ORIGIN = "https://user.qzone.qq.com";

/** 相册接口与回收站接口的 Accept 头, 与原 Rust 版逐字一致 */
const JSON_ACCEPT = "application/json, text/javascript, */*; q=0.01";
const ACTION_ACCEPT = "*/*";

/** 缩略图请求的 Accept 头, 与原 Rust 版逐字一致 */
const IMAGE_ACCEPT = "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8";

/** 缩略图内容类型缺失时的兜底, 与原 Rust 版一致 */
const DEFAULT_IMAGE_CONTENT_TYPE = "image/jpeg";

/** 恢复相册成功时必须满足的计数, 与原 Rust 版一致 */
const RECOVER_ALBUM_SUCCESS_COUNT = 1;

/** 恢复照片失败时随错误返回的响应正文长度上限, 对应 Rust 的 chars().take(300) */
const RECOVER_PHOTO_ERROR_BODY_LIMIT = 300;

/** 相册名称长度上限, 与原 Rust 版一致 */
const ALBUM_NAME_MAX_CHARS = 30;

/** 独立密码签名在进程内存中的当前取值, 对应 Rust 版 RecycleAuthState */
let recyclePwd2sig: string | null = null;

/** 读取已抓到的独立密码签名, 未抓到或已清理时为 null */
export function recycleSignature(): string | null {
  return recyclePwd2sig;
}

/** 记录独立密码签名, 原 WebView2 钩子的写入语义是直接覆盖 */
export function rememberRecycleSignature(token: string): void {
  recyclePwd2sig = token;
}

/** 清理独立密码签名, 打开新窗口与窗口关闭时都要调用 */
export function clearRecycleSignature(): void {
  recyclePwd2sig = null;
}

/**
 * 从地址的查询串中取 pwd2sig, 对应 Rust 版 pwd2sig_from_url
 *
 * 键名比较不区分大小写, 同名重复出现时取第一个; 地址无效或未携带该键时返回 null
 */
export function pwd2sigFromUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  for (const [key, token] of parsed.searchParams) {
    if (key.toLowerCase() === "pwd2sig") return token;
  }
  return null;
}

/**
 * 从页面地址的查询串或片段中取 pwd2sig, 对应 Rust 版 check_recycle_password 的地址兜底
 *
 * 腾讯验证成功后通常跳转到 callback.html 并把临时签名放在查询串或 hash 中; 空串视为未取到
 */
export function pwd2sigFromPageUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  for (const [key, token] of parsed.searchParams) {
    if (key.toLowerCase() === "pwd2sig" && token.length > 0) return token;
  }
  const fragment = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  for (const [key, token] of new URLSearchParams(fragment)) {
    if (key.toLowerCase() === "pwd2sig" && token.length > 0) return token;
  }
  return null;
}

/** 从窗口标题中取页面脚本发布的签名, 对应 Rust 版 title.strip_prefix 的读取方式 */
export function pwd2sigFromTitle(title: string): string | null {
  if (!title.startsWith(PWD2SIG_TITLE_PREFIX)) return null;
  const token = title.slice(PWD2SIG_TITLE_PREFIX.length);
  return token.length === 0 ? null : token;
}

/**
 * 抓取独立密码签名, 对应 Rust 版 install_recycle_request_listener 的回调体
 *
 * 只有回收站照片列表的请求会携带签名, 命中后写入会话状态并返回该签名
 */
export function captureRecycleSignature(requestUrl: string): string | null {
  if (!requestUrl.includes(RECYCLE_PHOTO_LIST_MARKER)) return null;
  const token = pwd2sigFromUrl(requestUrl);
  if (token === null) return null;
  rememberRecycleSignature(token);
  return token;
}

/** 回收站口令页地址, 对应 Rust 版 open_recycle_password_window 里的 page_url */
export function recyclePageUrl(uin: string): string {
  return `${QZONE_ORIGIN}/${uin}/photo/recycle`;
}

/** 取 HTTP 状态码与规范短语, 与 Rust 版 StatusCode 的 Display 输出一致 */
function statusText(status: number): string {
  const reason = STATUS_CODES[status];
  return reason === undefined ? String(status) : `${status} ${reason}`;
}

/** 异常统一转成短描述, 不携带任何凭证 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 按 Unicode 码点截断, 对应 Rust 的 chars().take(n) */
function truncateCodePoints(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit).join("");
}

/** 判断是否为 JSON 对象, 数组与 null 都不算 */
function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 响应对象视图: ensureQzoneSuccess 通过后必定是对象, 这里做一次显式收窄 */
function asJsonRecord(value: unknown): Record<string, unknown> {
  if (!isJsonRecord(value)) throw new Error("QQ 空间响应缺少 code 字段");
  return value;
}

/** 取无符号整数, 对应 serde_json 的 as_u64: 负数与非整数都返回 null */
function unsignedInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value <= Number.MAX_SAFE_INTEGER ? value : null;
}

/** 取响应中的 data 对象, 非对象时按空对象处理, 对应 Rust 的 unwrap_or_default */
function dataRecord(parsed: Record<string, unknown>): Record<string, unknown> {
  const data = parsed["data"];
  return isJsonRecord(data) ? data : {};
}

/** 合并接口地址覆盖项, 缺省即线上地址 */
function endpointsWith(overrides?: Partial<RecycleEndpoints>): RecycleEndpoints {
  return overrides === undefined ? QZONE_RECYCLE_ENDPOINTS : { ...QZONE_RECYCLE_ENDPOINTS, ...overrides };
}

/** 拼接查询串, 编码方式与 Rust 版 reqwest 的 query 序列化一致 */
function withQuery(base: string, fields: readonly QzoneFormField[]): string {
  const params = new URLSearchParams();
  for (const [name, value] of fields) params.append(name, value);
  return `${base}?${params.toString()}`;
}

/** 序列化表单正文, 编码方式与 Rust 版 reqwest 的 form 一致 */
function encodeForm(fields: readonly QzoneFormField[]): string {
  const params = new URLSearchParams();
  for (const [name, value] of fields) params.append(name, value);
  return params.toString();
}

/** 请求标识: 毫秒时间戳对 10^9 取模, 对应 Rust 的 rem_euclid */
function albumRequestId(): string {
  const modulus = 1_000_000_000;
  return String(((unixMillis() % modulus) + modulus) % modulus);
}

/** 回收站接口的公共查询参数, 顺序与原 Rust 版 recycle_get 一致 */
function recycleGetQuery(
  credentials: QzoneAuth,
  pwd2sig: string,
  extra: readonly QzoneFormField[],
): QzoneFormField[] {
  return [
    ["inCharset", "utf-8"],
    ["outCharset", "utf-8"],
    ["hostUin", credentials.uin],
    ["notice", "0"],
    ["format", "json"],
    ["plat", "qzone"],
    ["source", "qzone"],
    ["appid", "4"],
    ["uin", credentials.uin],
    ["output_type", "json"],
    ["pwd2sig", pwd2sig],
    ["g_tk", String(credentials.gTk)],
    ...extra,
  ];
}

/** 回收站 GET 请求地址, 导出以便离线校验参数组装 */
export function recycleGetRequestUrl(
  base: string,
  credentials: QzoneAuth,
  pwd2sig: string,
  extra: readonly QzoneFormField[],
): string {
  return withQuery(base, recycleGetQuery(credentials, pwd2sig, extra));
}

/** 回收站接口的公共请求头, 与原 Rust 版 recycle_get 一致 */
function recycleGetHeaders(credentials: QzoneAuth): Record<string, string> {
  return {
    Accept: JSON_ACCEPT,
    Referer: `${QZONE_ORIGIN}/${credentials.uin}/4`,
    "User-Agent": credentials.userAgent,
    Cookie: credentials.cookieHeader,
  };
}

/** 相册列表请求地址, 导出以便离线校验参数组装 */
export function albumListRequestUrl(base: string, credentials: QzoneAuth): string {
  return withQuery(base, [
    ["g_tk", String(credentials.gTk)],
    ["t", albumRequestId()],
    ["hostUin", credentials.uin],
    ["uin", credentials.uin],
    ["appid", "4"],
    ["inCharset", "utf-8"],
    ["outCharset", "utf-8"],
    ["source", "qzone"],
    ["plat", "qzone"],
    ["format", "jsonp"],
    ["notice", "0"],
    ["mode", "2"],
    ["sortOrder", "4"],
    ["pageStart", "0"],
    ["pageNum", "1000"],
    ["idcNum", "4"],
    ["callbackFun", "shine0"],
  ]);
}

/** 创建相册请求地址, 导出以便离线校验参数组装 */
export function createAlbumRequestUrl(base: string, credentials: QzoneAuth): string {
  return withQuery(base, [["g_tk", String(credentials.gTk)]]);
}

/** 创建相册的表单字段, 顺序与原 Rust 版 create_qzone_album 一致 */
export function createAlbumForm(name: string, uin: string): QzoneFormField[] {
  return [
    ["album_type", ""],
    ["birth_time", ""],
    ["degree_type", "0"],
    ["enroll_time", ""],
    ["albumname", name],
    ["albumdesc", ""],
    ["albumclass", "100"],
    ["priv", "1"],
    ["question", ""],
    ["answer", ""],
    ["whiteList", ""],
    ["bitmap", "10000000"],
    ["uin", uin],
    ["hostUin", uin],
    ["format", "fs"],
    ["inCharset", "utf-8"],
    ["outCharset", "utf-8"],
    ["notice", "0"],
    ["callbackFun", "_Callback"],
    ["plat", "qzone"],
    ["source", "qzone"],
    ["appid", "4"],
  ];
}

/** 恢复相册请求地址, 导出以便离线校验参数组装 */
export function recoverAlbumRequestUrl(base: string, credentials: QzoneAuth): string {
  return withQuery(base, [["g_tk", String(credentials.gTk)]]);
}

/** 恢复相册的表单字段, 顺序与原 Rust 版 recover_recycle_album 一致 */
export function recoverAlbumForm(
  credentials: QzoneAuth,
  pwd2sig: string,
  albumId: string,
): QzoneFormField[] {
  return [
    ["inCharset", "utf-8"],
    ["outCharset", "utf-8"],
    ["hostUin", credentials.uin],
    ["notice", "0"],
    ["callbackFun", "_Callback"],
    ["format", "fs"],
    ["plat", "qzone"],
    ["source", "qzone"],
    ["appid", "4"],
    ["uin", credentials.uin],
    ["albumId", albumId],
    ["pwd2sig", pwd2sig],
    ["qzreferrer", `${QZONE_ORIGIN}/${credentials.uin}`],
  ];
}

/** 恢复照片请求地址, 导出以便离线校验参数组装 */
export function recoverPhotosRequestUrl(base: string, credentials: QzoneAuth): string {
  return withQuery(base, [["g_tk", String(credentials.gTk)]]);
}

/**
 * 恢复照片的表单字段, 顺序与原 Rust 版 recover_recycle_photos 一致
 *
 * picList 由回收站来源相册 ID 与照片 ID 列表拼成, 目标相册 ID 单独放在 albumId 字段
 */
export function recoverPhotosForm(
  credentials: QzoneAuth,
  pwd2sig: string,
  sourceAlbumId: string,
  targetAlbumId: string,
  photoIds: readonly string[],
): QzoneFormField[] {
  return [
    ["uin", credentials.uin],
    ["hostUin", credentials.uin],
    ["albumId", targetAlbumId],
    ["picList", `${sourceAlbumId}@${photoIds.join("_")}`],
    ["pwd2sig", pwd2sig],
    ["format", "fs"],
    ["inCharset", "utf-8"],
    ["outCharset", "utf-8"],
    ["notice", "0"],
    ["callbackFun", "_Callback"],
    ["plat", "qzone"],
    ["source", "qzone"],
    ["appid", "4"],
    ["qzreferrer", `${QZONE_ORIGIN}/${credentials.uin}`],
  ];
}

/** 恢复类接口的公共请求头, 与原 Rust 版的恢复请求逐项一致 */
function recoverHeaders(credentials: QzoneAuth): Record<string, string> {
  return {
    Accept: ACTION_ACCEPT,
    "Accept-Language": ACCEPT_LANGUAGE,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Origin: QZONE_ORIGIN,
    Referer: `${QZONE_ORIGIN}/${credentials.uin}`,
    "User-Agent": credentials.userAgent,
    Cookie: credentials.cookieHeader,
    Priority: "u=1, i",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": URLENCODED_CONTENT_TYPE,
  };
}

/** 回收站 GET 请求并解析响应, 错误字符串与原 Rust 版 recycle_get 一致 */
async function recycleGet(
  credentials: QzoneAuth,
  base: string,
  pwd2sig: string,
  extra: readonly QzoneFormField[],
): Promise<Record<string, unknown>> {
  if (pwd2sig.trim().length === 0) throw new Error("独立密码验证已失效，请重新验证");
  const url = recycleGetRequestUrl(base, credentials, pwd2sig, extra);
  let response: Awaited<ReturnType<typeof fetchRemoteText>>;
  try {
    response = await fetchRemoteText(url, { headers: recycleGetHeaders(credentials) });
  } catch (error) {
    throw new Error(`请求相册回收站失败：${describeError(error)}`);
  }
  if (!response.ok) throw new Error(`请求相册回收站失败：HTTP ${statusText(response.status)}`);
  return asJsonRecord(ensureQzoneSuccess(parseQzoneJson(response.text)));
}

/**
 * 表单 POST 请求并解析响应
 *
 * 与原 Rust 版一致: 先判 HTTP 状态再解析正文; includeErrorBody 为真时把正文片段带进错误信息
 */
async function postJsonForm(
  url: string,
  headers: Record<string, string>,
  fields: readonly QzoneFormField[],
  failurePrefix: string,
  includeErrorBody: boolean,
): Promise<Record<string, unknown>> {
  let response: Awaited<ReturnType<typeof fetchRemoteText>>;
  try {
    response = await fetchRemoteText(url, { method: "POST", headers, body: encodeForm(fields) });
  } catch (error) {
    throw new Error(`${failurePrefix}：${describeError(error)}`);
  }
  if (!response.ok) {
    const detail = includeErrorBody
      ? ` ${truncateCodePoints(response.text, RECOVER_PHOTO_ERROR_BODY_LIMIT)}`
      : "";
    throw new Error(`${failurePrefix}：HTTP ${statusText(response.status)}${detail}`);
  }
  return asJsonRecord(ensureQzoneSuccess(parseQzoneJson(response.text)));
}

/** 对应原命令 list_recycle_albums */
export async function listRecycleAlbums(
  credentials: QzoneAuth,
  pwd2sig: string,
  endpoints?: Partial<RecycleEndpoints>,
): Promise<Record<string, unknown>> {
  const extra: QzoneFormField[] = [
    ["begin", "0"],
    ["size", "100"],
    ["refresh", "true"],
    ["day", "0"],
    ["dayNum", "365"],
  ];
  return await recycleGet(
    credentials,
    endpointsWith(endpoints).recycleAlbumList,
    pwd2sig,
    extra,
  );
}

/**
 * 对应原命令 list_recycle_photos
 *
 * albumId 为空串时不进入查询串, 与原 Rust 版 filter(|value| !value.is_empty()) 一致
 */
export async function listRecyclePhotos(
  credentials: QzoneAuth,
  pwd2sig: string,
  albumId?: string,
  endpoints?: Partial<RecycleEndpoints>,
): Promise<Record<string, unknown>> {
  const extra: QzoneFormField[] = [
    ["begin", "0"],
    ["size", "18"],
    ["type", "0"],
    ["refresh", "true"],
    ["day", "0"],
    ["dayNum", "90"],
  ];
  if (albumId !== undefined && albumId.length > 0) extra.push(["albumId", albumId]);
  return await recycleGet(
    credentials,
    endpointsWith(endpoints).recyclePhotoList,
    pwd2sig,
    extra,
  );
}

/** 判断主机名是否命中图片域名白名单, 对应 Rust 版的 ends_with 判定 */
export function isAllowedImageHost(
  host: string,
  suffixes: readonly string[] = QQ_IMAGE_HOST_SUFFIXES,
): boolean {
  return suffixes.some((suffix) => host.endsWith(suffix));
}

/**
 * 对应原命令 load_recycle_photo_preview
 *
 * 返回给渲染进程的是 data URL, 图片字节经 net.ts 取回后直接内联
 * allowedHostSuffixes 可覆盖, 缺省即基准的 QQ 图片域名白名单
 */
export async function loadRecyclePhotoPreview(
  credentials: QzoneAuth,
  imageUrl: string,
  allowedHostSuffixes: readonly string[] = QQ_IMAGE_HOST_SUFFIXES,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new Error("照片缩略图地址无效");
  }
  if (!isAllowedImageHost(parsed.hostname, allowedHostSuffixes)) {
    throw new Error("照片缩略图地址不是 QQ 图片域名");
  }
  let response: Awaited<ReturnType<typeof fetchRemoteBytes>>;
  try {
    response = await fetchRemoteBytes(imageUrl, {
      headers: {
        Accept: IMAGE_ACCEPT,
        Referer: recyclePageUrl(credentials.uin),
        "User-Agent": credentials.userAgent,
        Cookie: credentials.cookieHeader,
      },
    });
  } catch (error) {
    throw new Error(`读取照片缩略图失败：${describeError(error)}`);
  }
  if (!response.ok) throw new Error(`读取照片缩略图失败：HTTP ${statusText(response.status)}`);
  const raw = response.contentType.length === 0 ? DEFAULT_IMAGE_CONTENT_TYPE : response.contentType;
  const separator = raw.indexOf(";");
  const contentType = separator >= 0 ? raw.slice(0, separator) : raw;
  return `data:${contentType};base64,${response.bytesBase64}`;
}

/** 对应原命令 list_qzone_albums */
export async function listQzoneAlbums(
  credentials: QzoneAuth,
  endpoints?: Partial<RecycleEndpoints>,
): Promise<Record<string, unknown>> {
  const url = albumListRequestUrl(endpointsWith(endpoints).albumList, credentials);
  let response: Awaited<ReturnType<typeof fetchRemoteText>>;
  try {
    response = await fetchRemoteText(url, {
      headers: {
        Accept: JSON_ACCEPT,
        Referer: `${QZONE_ORIGIN}/`,
        "User-Agent": credentials.userAgent,
        Cookie: credentials.cookieHeader,
      },
    });
  } catch (error) {
    throw new Error(`获取相册列表失败：${describeError(error)}`);
  }
  if (!response.ok) throw new Error(`获取相册列表失败：HTTP ${statusText(response.status)}`);
  return asJsonRecord(ensureQzoneSuccess(parseQzoneJson(response.text)));
}

/** 对应原命令 create_qzone_album, 名称按码点数限制在 30 以内 */
export async function createQzoneAlbum(
  credentials: QzoneAuth,
  name: string,
  endpoints?: Partial<RecycleEndpoints>,
): Promise<Record<string, unknown>> {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("相册名称不能为空");
  if (Array.from(trimmed).length > ALBUM_NAME_MAX_CHARS) {
    throw new Error(`相册名称不能超过 ${ALBUM_NAME_MAX_CHARS} 个字符`);
  }
  const url = createAlbumRequestUrl(endpointsWith(endpoints).createAlbum, credentials);
  return await postJsonForm(
    url,
    {
      Referer: `${QZONE_ORIGIN}/${credentials.uin}/photo`,
      "User-Agent": credentials.userAgent,
      Cookie: credentials.cookieHeader,
      Origin: QZONE_ORIGIN,
      "Content-Type": URLENCODED_CONTENT_TYPE,
    },
    createAlbumForm(trimmed, credentials.uin),
    "创建相册失败",
    false,
  );
}

/** 对应原命令 recover_recycle_album, 服务端必须报告成功 1 个且失败 0 个 */
export async function recoverRecycleAlbum(
  credentials: QzoneAuth,
  pwd2sig: string,
  albumId: string,
  endpoints?: Partial<RecycleEndpoints>,
): Promise<Record<string, unknown>> {
  if (pwd2sig.trim().length === 0) throw new Error("独立密码验证已失效，请重新验证");
  if (albumId.trim().length === 0) throw new Error("缺少回收站相册 ID");
  const url = recoverAlbumRequestUrl(endpointsWith(endpoints).recoverAlbum, credentials);
  const parsed = await postJsonForm(
    url,
    recoverHeaders(credentials),
    recoverAlbumForm(credentials, pwd2sig, albumId),
    "恢复相册失败",
    false,
  );
  const data = dataRecord(parsed);
  const succeeded = unsignedInteger(data["succ_num"]) ?? 0;
  const failed = unsignedInteger(data["fail_num"]) ?? 0;
  if (succeeded !== RECOVER_ALBUM_SUCCESS_COUNT || failed !== 0) {
    throw new Error(`相册恢复未完成：成功 ${succeeded} 个，失败 ${failed} 个`);
  }
  return parsed;
}

/**
 * 对应原命令 recover_recycle_photos
 *
 * 与原 Rust 版一致: 请求张数与 succ_num 不符时报错, 缺 succ_num 时不额外校验
 */
export async function recoverRecyclePhotos(
  credentials: QzoneAuth,
  pwd2sig: string,
  sourceAlbumId: string,
  targetAlbumId: string,
  photoIds: readonly string[],
  endpoints?: Partial<RecycleEndpoints>,
): Promise<Record<string, unknown>> {
  if (photoIds.length === 0) throw new Error("请先选择需要恢复的照片");
  if (sourceAlbumId.trim().length === 0) throw new Error("照片缺少回收站来源相册 ID");
  if (targetAlbumId.trim().length === 0) throw new Error("照片缺少恢复目标相册 ID");
  const url = recoverPhotosRequestUrl(endpointsWith(endpoints).recoverPhotos, credentials);
  const parsed = await postJsonForm(
    url,
    recoverHeaders(credentials),
    recoverPhotosForm(credentials, pwd2sig, sourceAlbumId, targetAlbumId, photoIds),
    "恢复照片失败",
    true,
  );
  const data = dataRecord(parsed);
  const succeeded = unsignedInteger(data["succ_num"]);
  if (succeeded === null) return parsed;
  const expected = photoIds.length;
  if (succeeded !== expected) {
    const reported = unsignedInteger(data["fail_num"]);
    const failed = reported ?? Math.max(expected - succeeded, 0);
    throw new Error(`照片恢复未完成：请求 ${expected} 张，成功 ${succeeded} 张，失败 ${failed} 张`);
  }
  return parsed;
}
