/**
 * QQ 空间互动列表接口客户端
 *
 * 行为基准为 temp/reference/src-tauri/src/qzone.rs 的互动列表部分: 接口地址, 查询参数, 请求头,
 * 重试与退避策略, 错误字符串都与之对齐
 * 相册与回收站相关接口属于阶段三范围, 不在本模块内
 * 凭证由调用方注入, 本模块不保存任何状态, 任何日志都不得写入 Cookie 原文
 */

import { STATUS_CODES } from "node:http";

import { fetchRemoteText } from "../net.js";
import { FEED_RESPONSE_ATTEMPTS, FEED_RETRY_BASE_DELAY_MS } from "./constants.js";
import { cookieHeader } from "./loginPrimitives.js";

/** 互动列表接口地址, 与原 Rust 版 FEEDS_URL 一致 */
export const FEEDS_URL = "https://mobile.qzone.qq.com/get_feeds";

/** 请求语言头, 与原 Rust 版逐字一致 */
const ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6,zh-TW;q=0.5";

/** 接口要求的来源与引用页, 与原 Rust 版一致 */
const FEED_ORIGIN = "https://h5.qzone.qq.com";
const FEED_REFERER = "https://h5.qzone.qq.com/";

/** 命中即视为永久错误而不重试的关键字, 与原 Rust 版一致 */
const PERMANENT_ERROR_KEYWORDS: readonly string[] = [
  "未登录",
  "登录失效",
  "权限",
  "封禁",
  "禁止访问",
  "p_skey",
];

/** JSON 解析失败的哨兵, JSON 文本不存在该取值, 因此不会与解析成功的结果混淆 */
const JSON_PARSE_FAILED: unique symbol = Symbol("qzone-json-parse-failed");

/** 互动列表的刷新方式, 1 为第一页, 2 为携带游标的下一页 */
export type FeedRefreshType = "1" | "2";

/**
 * 客户端需要的凭证视图
 *
 * 与登录模块的 QzoneLoginCredentials 结构一致, 可直接传入
 * uin 目前不参与互动列表请求, 保留该字段以维持凭证结构对齐
 * cookies 既接受登录模块的 Cookie 记录, 也接受已拼接好的 Cookie 头
 */
export interface QzoneFeedCredentials {
  uin: string;
  gTk: number;
  cookies: Record<string, string> | string;
  userAgent: string;
}

/** 互动列表条目, 具体字段由服务端决定, 读取时逐项判型 */
export type QzoneFeedRecord = Record<string, unknown>;

/** 单页互动列表, 字段名与 Rust 版 FeedPage 的 camelCase 序列化结果一致 */
export interface QzoneFeedPage {
  feeds: QzoneFeedRecord[];
  attachInfo: string | null;
  hasMore: boolean;
}

/** 查询串键值对, 数组顺序即拼接顺序 */
type QueryPair = [string, string];

/** 判断是否为 JSON 对象, 数组与 null 都不算 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 严格解析 JSON, 失败时返回哨兵 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return JSON_PARSE_FAILED;
  }
}

/** 去掉首尾空白与 BOM, 对应 Rust 版 parse_qzone_json 的规整步骤 */
function normalizeQzoneText(text: string): string {
  return text.trim().replace(/^\uFEFF+/u, "").trim();
}

/** 按 Unicode 码点截断, 对应 Rust 的 chars().take(n) */
function truncateCodePoints(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit).join("");
}

/** 取整数形式的 JSON 数字, 非整数或超出安全范围时返回 null, 对应 serde_json 的 as_i64 */
function numericInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
}

/** 取 code 字段: 先按整数, 再按十进制字符串, 对应 Rust 的 as_i64 加 i64 的 parse */
function codeInteger(value: unknown): number | null {
  const numeric = numericInteger(value);
  if (numeric !== null) return numeric;
  if (typeof value !== "string" || !/^[+-]?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** 取错误描述: 只认 message, 该键不存在时才退回 msg, 与 Rust 的 or_else 语义一致 */
function responseMessage(record: Record<string, unknown>): string {
  const candidate = Object.hasOwn(record, "message") ? record["message"] : record["msg"];
  return typeof candidate === "string" ? candidate : "未知错误";
}

/** 取 HTTP 状态码与规范短语, 对应 Rust 版 http crate 的 canonical_reason */
function statusText(status: number): string {
  const reason = STATUS_CODES[status];
  return reason === undefined ? String(status) : `${status} ${reason}`;
}

/**
 * 解析 QQ 空间响应文本
 *
 * 依次尝试: 直接 JSON, frameElement.callback 包装, 最后从后向前扫描最外层对象
 * 空响应按原基准视为 {"code":0}; 全部失败时抛出解析错误
 * 该函数同时服务相册与回收站接口, 是阶段三的复用入口
 */
export function parseQzoneJson(text: string): unknown {
  const normalized = normalizeQzoneText(text);
  if (normalized.length === 0) return { code: 0 };
  const direct = tryParseJson(normalized);
  if (direct !== JSON_PARSE_FAILED) return direct;
  const callback = normalized.lastIndexOf("frameElement.callback(");
  if (callback >= 0) {
    const start = normalized.indexOf("{", callback);
    const end = normalized.lastIndexOf("}");
    if (start >= 0 && end >= start) {
      const value = tryParseJson(normalized.slice(start, end + 1));
      if (value !== JSON_PARSE_FAILED) return value;
    }
  }
  const starts: number[] = [];
  for (let index = normalized.indexOf("{"); index >= 0; index = normalized.indexOf("{", index + 1)) {
    starts.push(index);
  }
  let bestWithCode: { span: number; value: unknown } | null = null;
  let fallback: unknown = JSON_PARSE_FAILED;
  for (let position = starts.length - 1; position >= 0; position -= 1) {
    const start = starts[position];
    const ends: number[] = [];
    for (let index = normalized.indexOf("}", start); index >= 0; index = normalized.indexOf("}", index + 1)) {
      ends.push(index + 1);
    }
    // 与 Rust 版一致: 每个起点只尝试其后的最后 80 个右花括号, 并由后向前
    const candidates = ends.length > 80 ? ends.slice(ends.length - 80) : ends;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const end = candidates[index];
      const value = tryParseJson(normalized.slice(start, end));
      if (value === JSON_PARSE_FAILED) continue;
      const span = end - start;
      const hasCode = isJsonObject(value) && Object.hasOwn(value, "code");
      if (hasCode && (bestWithCode === null || span > bestWithCode.span)) {
        bestWithCode = { span, value };
      } else if (fallback === JSON_PARSE_FAILED) {
        fallback = value;
      }
    }
  }
  if (bestWithCode !== null) return bestWithCode.value;
  if (fallback !== JSON_PARSE_FAILED) return fallback;
  throw new Error(`解析 QQ 空间响应失败：响应片段：${truncateCodePoints(normalized, 180)}`);
}

/**
 * 校验 QQ 空间响应的 code 字段, 0 视为成功
 *
 * 对应 Rust 版 ensure_qzone_success: 缺少 code 或 code 非整数与非十进制字符串都报错
 */
export function ensureQzoneSuccess(value: unknown): unknown {
  if (!isJsonObject(value)) throw new Error("QQ 空间响应缺少 code 字段");
  const code = codeInteger(value["code"]);
  if (code === null) throw new Error("QQ 空间响应缺少 code 字段");
  if (code === 0) return value;
  throw new Error(`QQ 空间接口返回错误 ${code}：${responseMessage(value)}`);
}

/** 读取 vFeeds 数组, 非数组按空列表处理, 对应原基准的 unwrap_or_default */
function readFeedRecords(data: unknown): QzoneFeedRecord[] {
  if (!isJsonObject(data)) return [];
  const raw = data["vFeeds"];
  if (!Array.isArray(raw)) return [];
  // 前端 FeedPage 声明条目为对象, 这里按原样保留: 非对象条目的字段读取会被归档引擎忽略
  return raw as QzoneFeedRecord[];
}

/** 读取 attachinfo, 空串视为没有游标 */
function readAttachInfo(data: unknown): string | null {
  if (!isJsonObject(data)) return null;
  const raw = data["attachinfo"];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** 读取 hasmore, 只有整数非 0 才算服务端还有数据 */
function readHasMore(data: unknown): boolean {
  if (!isJsonObject(data)) return false;
  return (numericInteger(data["hasmore"]) ?? 0) !== 0;
}

/**
 * 解析单页互动列表
 *
 * 对应 Rust 版 parse_feed_page: code 为非 0 整数时报错, 缺少 data 时报错
 * hasMore 要求服务端标记还有数据, 且本页非空并带回游标
 */
export function parseFeedPage(value: unknown): QzoneFeedPage {
  if (isJsonObject(value)) {
    const code = numericInteger(value["code"]);
    if (code !== null && code !== 0) {
      throw new Error(`QQ 空间动态接口返回错误 ${code}：${responseMessage(value)}`);
    }
  }
  if (!isJsonObject(value) || !Object.hasOwn(value, "data")) throw new Error("动态响应中缺少 data");
  const data = value["data"];
  const feeds = readFeedRecords(data);
  const attachInfo = readAttachInfo(data);
  const hasMore = readHasMore(data) && feeds.length > 0 && attachInfo !== null;
  return { feeds, attachInfo, hasMore };
}

/**
 * 判断响应是否值得重试, 对应 Rust 版 retryable_response_reason
 *
 * 429 与 5xx 一律重试; 其余非 2xx 不重试
 * 2xx 时正文不是有效 JSON, 或返回非 0 的临时错误码, 或缺少 data, 都值得重试
 * 错误描述命中登录失效一类关键字时视为永久错误, 不重试
 */
export function retryableResponseReason(status: number, body: string): string | null {
  if (status === 429 || (status >= 500 && status <= 599)) return `HTTP ${statusText(status)}`;
  if (status < 200 || status > 299) return null;
  const value = tryParseJson(body);
  if (value === JSON_PARSE_FAILED) return "响应不是有效 JSON";
  if (!isJsonObject(value)) return "响应中暂时缺少 data";
  const code = numericInteger(value["code"]);
  if (code !== null && code !== 0) {
    const message = responseMessage(value);
    if (PERMANENT_ERROR_KEYWORDS.some((keyword) => message.includes(keyword))) return null;
    return `接口错误 ${code}：${message}`;
  }
  if (!Object.hasOwn(value, "data")) return "响应中暂时缺少 data";
  return null;
}

/** 判断错误是否属于可跳过的单页错误, 对应 Rust 版 feed_error_can_skip */
export function feedErrorCanSkip(error: string): boolean {
  return (
    error.includes("HTTP 5") ||
    error.startsWith("解析空间动态失败：") ||
    error.startsWith("QQ 空间动态接口返回错误")
  );
}

/** 第 n 次重试前的退避毫秒数, 基础值按 2 的幂次增长, 对应 Rust 版 feed_retry_delay */
export function feedRetryDelayMs(attempt: number): number {
  return FEED_RETRY_BASE_DELAY_MS * 2 ** (Math.max(1, Math.trunc(attempt)) - 1);
}

/** 按 UA 推断 sec-ch-ua 头, 与原 Rust 版 sec_ch_ua 一致 */
export function secChUa(userAgent: string): string {
  const start = userAgent.indexOf("Chrome/");
  if (start < 0) return '"Not;A=Brand";v="8", "Apple";v="0", "Safari";v="18"';
  const major = /^\d+/.exec(userAgent.slice(start + "Chrome/".length))?.[0] ?? "";
  const version = major.length === 0 ? "131" : major;
  return `"Not;A=Brand";v="8", "Chromium";v="${version}", "Microsoft Edge";v="${version}"`;
}

/** 按 UA 推断 sec-ch-ua-platform 头, 与原 Rust 版 sec_platform 一致 */
export function secPlatform(userAgent: string): string {
  return userAgent.includes("iPhone") ? '"iOS"' : '"Android"';
}

/** 取 Cookie 头: 既接受登录模块的 Cookie 记录, 也接受已拼接好的头 */
function credentialCookieHeader(credentials: QzoneFeedCredentials): string {
  return typeof credentials.cookies === "string" ? credentials.cookies : cookieHeader(credentials.cookies);
}

/**
 * 组装互动列表的查询参数, 顺序与 Rust 版一致
 *
 * 游标保持服务端原文, 由查询串序列化统一编码, 空游标不进入参数表
 */
function feedQuery(
  credentials: QzoneFeedCredentials,
  refreshType: FeedRefreshType,
  attachInfo: string | null,
): QueryPair[] {
  const query: QueryPair[] = [
    ["g_tk", String(credentials.gTk)],
    ["res_type", "1"],
    ["refresh_type", refreshType],
    ["format", "json"],
  ];
  if (attachInfo !== null && attachInfo.trim().length > 0) query.push(["res_attach", attachInfo]);
  return query;
}

/** 拼接查询串, 编码方式与 Rust 版 reqwest 的 query 序列化一致 */
function withQuery(base: string, query: QueryPair[]): string {
  const params = new URLSearchParams();
  for (const [name, value] of query) params.append(name, value);
  return `${base}?${params.toString()}`;
}

/** 互动列表请求地址, 导出以便离线校验游标编码 */
export function feedRequestUrl(
  credentials: QzoneFeedCredentials,
  refreshType: FeedRefreshType,
  attachInfo: string | null,
): string {
  return withQuery(FEEDS_URL, feedQuery(credentials, refreshType, attachInfo));
}

/** 组装请求头, 逐项与原 Rust 版一致 */
function feedHeaders(credentials: QzoneFeedCredentials): Record<string, string> {
  return {
    Accept: "application/json",
    "Accept-Language": ACCEPT_LANGUAGE,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Origin: FEED_ORIGIN,
    Referer: FEED_REFERER,
    "User-Agent": credentials.userAgent,
    Cookie: credentialCookieHeader(credentials),
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "Sec-Ch-Ua": secChUa(credentials.userAgent),
    "Sec-Ch-Ua-Mobile": "?1",
    "Sec-Ch-Ua-Platform": secPlatform(credentials.userAgent),
  };
}

/** 把网络异常归成短描述, 与 Rust 版 is_timeout 与 is_connect 的分类对应 */
function transportErrorKind(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = describeError(error);
  if (name === "AbortError" || name === "TimeoutError" || message.includes("timed out")) return "请求超时";
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR|socket hang up|fetch failed/.test(message)) {
    return "连接失败";
  }
  return "传输失败";
}

/** 异常统一转成短描述, 不携带任何凭证 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 退避等待, 对应 Rust 版的 tokio sleep */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** 请求失败诊断的入参, 字段与 Rust 版 log_feed_request_error 对应 */
interface FeedRequestErrorLog {
  stage: string;
  requestUrl: string;
  query: QueryPair[];
  userAgent: string;
  status: number | null;
  contentType: string | null;
  responseBody: string | null;
  transportAttempts: string[];
  error: string;
}

/**
 * 输出请求失败诊断
 *
 * 只写 stderr, 不落盘; net.ts 只暴露 content-type 一项响应头, 因此诊断块记录该字段
 * Cookie 原文一律以占位符替代, 登录凭证不得进入日志
 */
function logFeedRequestError(entry: FeedRequestErrorLog): void {
  const parameters: Record<string, string> = {};
  for (const [name, value] of entry.query) parameters[name] = value;
  let body: unknown = null;
  if (entry.responseBody !== null) {
    const parsed = tryParseJson(entry.responseBody);
    body =
      parsed === JSON_PARSE_FAILED
        ? {
            format: "raw",
            bytesReceived: Buffer.byteLength(entry.responseBody, "utf8"),
            content: "非完整 JSON 或非 JSON 响应，原始正文见本诊断块下方",
          }
        : parsed;
  }
  const diagnostic = {
    event: "qzone_archive_request_error",
    stage: entry.stage,
    error: entry.error,
    request: {
      method: "GET",
      url: entry.requestUrl,
      parameters,
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": ACCEPT_LANGUAGE,
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Origin: FEED_ORIGIN,
        Referer: FEED_REFERER,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        "Sec-Ch-Ua-Mobile": "?1",
        "User-Agent": entry.userAgent,
        Cookie: "[已隐藏：登录凭证不会写入控制台]",
      },
    },
    response: {
      status: entry.status,
      statusText: entry.status === null ? null : STATUS_CODES[entry.status] ?? null,
      contentType: entry.contentType,
      body,
    },
    transportAttempts: entry.transportAttempts,
  };
  console.error(`\n================ QZONE ARCHIVE REQUEST ERROR ================\n${JSON.stringify(diagnostic, null, 2)}`);
  if (entry.responseBody !== null) {
    console.error(
      `---------------- RAW RESPONSE BODY ----------------\n${entry.responseBody}\n---------------- END RAW RESPONSE BODY ----------------`,
    );
  }
  console.error("================ END QZONE ARCHIVE REQUEST ERROR ================\n");
}

/** 单次请求的结果, 只保留后续判定需要的字段 */
interface FeedResponse {
  status: number;
  contentType: string;
  body: string;
}

/**
 * 按给定次数请求互动列表, 对应 Rust 版 fetch_feeds_with_attempts
 *
 * attempts 至少按 1 次执行; 可重试响应在还有剩余次数时按 2 的幂次退避后重试,
 * 最后一次即使仍判定为可重试也会按原样进入解析, 由解析结果决定错误文案
 */
export async function fetchFeedsWithAttempts(
  credentials: QzoneFeedCredentials,
  refreshType: FeedRefreshType,
  attachInfo: string | null,
  attempts: number = FEED_RESPONSE_ATTEMPTS,
): Promise<QzoneFeedPage> {
  const query = feedQuery(credentials, refreshType, attachInfo);
  if (attachInfo !== null && attachInfo.trim().length === 0) {
    const error = "分页游标不能为空";
    logFeedRequestError({
      stage: "validate_request",
      requestUrl: FEEDS_URL,
      query,
      userAgent: credentials.userAgent,
      status: null,
      contentType: null,
      responseBody: null,
      transportAttempts: [],
      error,
    });
    throw new Error(error);
  }
  const requestUrl = withQuery(FEEDS_URL, query);
  const headers = feedHeaders(credentials);
  const total = Math.max(1, Math.trunc(attempts));
  const transportAttempts: string[] = [];
  let response: FeedResponse | null = null;
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= total; attempt += 1) {
    let result: QzaRemoteFetchTextResult;
    try {
      result = await fetchRemoteText(requestUrl, { headers });
    } catch (error) {
      const detail = `${transportErrorKind(error)}（第 ${attempt}/${total} 次）：${describeError(error)}`;
      transportAttempts.push(detail);
      lastError = detail;
      if (attempt < total) await sleep(feedRetryDelayMs(attempt));
      continue;
    }
    const reason = retryableResponseReason(result.status, result.text);
    if (reason !== null) {
      const detail = `${reason}（第 ${attempt}/${total} 次）`;
      transportAttempts.push(detail);
      logFeedRequestError({
        stage: `retryable_response_attempt_${attempt}`,
        requestUrl,
        query,
        userAgent: credentials.userAgent,
        status: result.status,
        contentType: result.contentType,
        responseBody: result.text,
        transportAttempts,
        error: detail,
      });
      if (attempt < total) {
        await sleep(feedRetryDelayMs(attempt));
        continue;
      }
    }
    response = { status: result.status, contentType: result.contentType, body: result.text };
    break;
  }
  if (response === null) {
    const error = `获取空间动态失败：${lastError ?? "未知网络错误"}`;
    logFeedRequestError({
      stage: "transport",
      requestUrl,
      query,
      userAgent: credentials.userAgent,
      status: null,
      contentType: null,
      responseBody: null,
      transportAttempts,
      error,
    });
    throw new Error(error);
  }
  const failure = { requestUrl, query, userAgent: credentials.userAgent, transportAttempts };
  if (response.status < 200 || response.status > 299) {
    const error = `获取空间动态失败：HTTP ${statusText(response.status)}`;
    logFeedRequestError({
      ...failure,
      stage: "http_status",
      status: response.status,
      contentType: response.contentType,
      responseBody: response.body,
      error,
    });
    throw new Error(error);
  }
  let value: unknown;
  try {
    value = JSON.parse(response.body) as unknown;
  } catch (error) {
    const message = `解析空间动态失败：${describeError(error)}`;
    logFeedRequestError({
      ...failure,
      stage: "parse_json",
      status: response.status,
      contentType: response.contentType,
      responseBody: response.body,
      error: message,
    });
    throw new Error(message);
  }
  try {
    return parseFeedPage(value);
  } catch (error) {
    logFeedRequestError({
      ...failure,
      stage: "parse_api_response",
      status: response.status,
      contentType: response.contentType,
      responseBody: response.body,
      error: describeError(error),
    });
    throw error;
  }
}

/** 通用入口, 对应 Rust 版 fetch_feeds: 按 FEED_RESPONSE_ATTEMPTS 次请求 */
export function fetchFeeds(
  credentials: QzoneFeedCredentials,
  refreshType: FeedRefreshType,
  attachInfo: string | null,
): Promise<QzoneFeedPage> {
  return fetchFeedsWithAttempts(credentials, refreshType, attachInfo, FEED_RESPONSE_ATTEMPTS);
}

/** 取第一页, 对应原命令 fetch_first_feeds */
export function fetchFirstFeeds(credentials: QzoneFeedCredentials): Promise<QzoneFeedPage> {
  return fetchFeeds(credentials, "1", null);
}

/** 携带游标取下一页, 对应原命令 fetch_more_feeds */
export function fetchMoreFeeds(credentials: QzoneFeedCredentials, attachInfo: string): Promise<QzoneFeedPage> {
  return fetchFeeds(credentials, "2", attachInfo);
}

/** 单次请求不重试, 对应 Rust 版 fetch_feeds_once, 供异常页探测与找回使用 */
export function fetchFeedsOnce(
  credentials: QzoneFeedCredentials,
  refreshType: FeedRefreshType,
  attachInfo: string | null,
): Promise<QzoneFeedPage> {
  return fetchFeedsWithAttempts(credentials, refreshType, attachInfo, 1);
}
