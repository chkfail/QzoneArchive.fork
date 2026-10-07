/**
 * 归档媒体加载与缓存
 *
 * 行为基准为 temp/reference/src-tauri/src/archive.rs 的 list_archived_media(2082-2166),
 * load_archived_image(1048-1165), load_archived_video(1202-1310) 以及它用到的
 * existing_archived_image(1027), archived_image_extension(993), is_qq_missing_image_placeholder(1013)
 * 本模块是纯 Node 层, 禁止 import electron: 图片目录, 视频目录与数据库句柄都由命令层注入
 * 返回给渲染进程的是数据根目录内的绝对路径, 由 qza:// 协议负责读取
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fetchRemoteBytes } from "../net.js";
import { pictureUrlCandidates, pictureUrls, videoCoverUrl, videoUrls } from "./archiveParser.js";
import {
  IMAGE_DOWNLOAD_CONCURRENCY,
  IMAGE_MAX_BYTES,
  IMAGE_REQUEST_TIMEOUT_MS,
  VIDEO_REQUEST_TIMEOUT_MS,
} from "./constants.js";

/** 图片归档扩展名的尝试顺序, 与基准 existing_archived_image 的数组顺序逐项一致 */
export const ARCHIVED_IMAGE_EXTENSIONS = ["jpg", "png", "gif", "webp", "avif", "bmp"] as const;

/** 媒体分页单页条数上限, 对应基准 list_archived_media 的 limit.clamp(1, 100) */
export const MEDIA_PAGE_SIZE_LIMIT = 100;

/** 图片缓存有效的最小字节数, 基准要求严格大于 32 字节 */
const MIN_CACHED_IMAGE_BYTES = 32;

/** 视频缓存有效的最小字节数, 基准要求严格大于 1024 字节 */
const MIN_CACHED_VIDEO_BYTES = 1024;

/** 图片与视频请求的固定请求头, 与基准逐字一致 */
const IMAGE_ACCEPT = "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8";
const VIDEO_ACCEPT = "video/mp4,video/*;q=0.9,application/octet-stream;q=0.8,*/*;q=0.5";
const ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6,zh-TW;q=0.5";
const IMAGE_REFERER = "https://user.qzone.qq.com/";

/**
 * 候选地址与可选请求头的尝试组合, 顺序与基准一致:
 * 依次为带 Cookie 带 Referer, 只带 Cookie, 只带 Referer, 都不带
 */
const REQUEST_VARIANTS: readonly (readonly [boolean, boolean])[] = [
  [true, true],
  [true, false],
  [false, true],
  [false, false],
];

/** 输出给渲染进程的单条媒体项, 字段名与基准的 camelCase 序列化结果一致 */
export interface ArchiveMediaItem {
  key: string;
  dynamicId: number;
  mediaType: "photo" | "video";
  pictureIndex: number | null;
  url: string;
  coverUrl: string | null;
  publishedAt: number;
  authorUin: string | null;
  authorName: string | null;
  content: string | null;
}

/** 媒体分页结果, 年份列表用于渲染进程的年份筛选 */
export interface ArchiveMediaPage {
  items: ArchiveMediaItem[];
  total: number;
  years: number[];
}

/**
 * 图片加载所需的运行输入
 *
 * 数据库句柄由命令层在 readPicturesJson 内部按需开合: 命中磁盘缓存时不触碰数据库,
 * 与基准先在文件系统查找缓存再查库的顺序一致
 */
export interface ArchivedImageRequest {
  imageDir: string;
  userAgent: string;
  cookieHeader: string;
  readPicturesJson: () => string | null;
}

/** 视频加载所需的运行输入, 缓存文件名需要归属账号 */
export interface ArchivedVideoRequest {
  ownerUin: string;
  videoDir: string;
  userAgent: string;
  cookieHeader: string;
  readVideoJson: () => string | null;
}

/** 字节前缀比较, 长度不足即不匹配 */
function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

/** 从指定偏移比较 ASCII 文本, 越界即不匹配 */
function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || offset + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/** 文件字节数, 不存在或无法读取时返回 -1 */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/** 安全删除, 失败时不影响主流程 */
function removeFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // 删除失败按基准忽略
  }
}

/** 网络与文件系统异常统一转成短描述 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 取有限整数, 非法值回落到给定的缺省值 */
function finiteInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/** 夹取分页条数, 对应基准的 limit.clamp(1, 100) */
function pageLimit(value: number): number {
  return Math.min(Math.max(1, finiteInteger(value, MEDIA_PAGE_SIZE_LIMIT)), MEDIA_PAGE_SIZE_LIMIT);
}

/**
 * 按文件头判定图片扩展名, 与基准 archived_image_extension 对应
 *
 * 无法识别时返回 null, 调用方按"QQ 返回了非图片内容"处理
 */
export function archivedImageExtension(bytes: Uint8Array): string | null {
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "gif";
  if (asciiAt(bytes, 0, "BM")) return "bmp";
  if (bytes.length >= 12 && asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "webp";
  if (asciiAt(bytes, 4, "ftyp") && (asciiAt(bytes, 8, "avif") || asciiAt(bytes, 8, "avis"))) {
    return "avif";
  }
  return null;
}

/**
 * 识别 QQ 空间的"原图已不存在"占位图, 与基准 is_qq_missing_image_placeholder 对应
 *
 * 基准按 GIF 头中的宽高与整体长度做四组匹配, 命中即认为字节内容不是真实图片
 */
export function isQqMissingImagePlaceholder(bytes: Uint8Array): boolean {
  if (bytes.length < 10) return false;
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  return (
    (bytes.length === 2_038 && asciiAt(bytes, 0, "GIF89a") && width === 340 && height === 320) ||
    (bytes.length === 2_687 && asciiAt(bytes, 0, "GIF89a") && width === 340 && height === 320) ||
    (bytes.length === 1_643 && asciiAt(bytes, 0, "GIF87a") && width === 99 && height === 99) ||
    (bytes.length === 1_547 && asciiAt(bytes, 0, "GIF87a") && width === 98 && height === 98)
  );
}

/** 读取 gif 并判定占位图, 读取失败按非占位图处理, 与基准的 is_ok_and 一致 */
function gifIsMissingPlaceholder(path: string): boolean {
  try {
    return isQqMissingImagePlaceholder(readFileSync(path));
  } catch {
    return false;
  }
}

/**
 * 按扩展名顺序查找已归档的图片, 与基准 existing_archived_image 对应
 *
 * 文件不足 33 字节视为无效; 占位图会先删掉再继续尝试后续扩展名; 都找不到返回 null
 */
export function existingArchivedImage(imageDir: string, fileStem: string): string | null {
  for (const extension of ARCHIVED_IMAGE_EXTENSIONS) {
    const path = join(imageDir, `${fileStem}.${extension}`);
    if (fileSize(path) <= MIN_CACHED_IMAGE_BYTES) continue;
    if (extension === "gif" && gifIsMissingPlaceholder(path)) {
      removeFile(path);
      continue;
    }
    return path;
  }
  return null;
}

/**
 * 图片下载并发闸门
 *
 * 与基准 QLoginState 中的图片下载信号量对应, 上限取 IMAGE_DOWNLOAD_CONCURRENCY:
 * 多个图片请求可以并行, 超出上限的调用在此排队; 视频下载不占用该名额, 与基准一致
 */
class ImageDownloadGate {
  private readonly limit: number;
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.trunc(limit));
  }

  /** 取得一个下载名额并返回释放函数, 释放函数可重复调用 */
  async acquire(): Promise<() => void> {
    this.active += 1;
    if (this.active > this.limit) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

/** 进程内唯一的图片下载闸门, 与基准的单例信号量一致 */
const imageDownloadGate = new ImageDownloadGate(IMAGE_DOWNLOAD_CONCURRENCY);

/** 读取动态表中的单个 JSON 字段列, 列名取自本模块常量, 不拼接外部输入 */
function readDynamicJson(
  db: DatabaseSync,
  ownerUin: string,
  id: number,
  column: "pictures_json" | "video_json",
  missingMessage: string,
  failurePrefix: string,
): string | null {
  let row: Record<string, unknown> | undefined;
  try {
    row = db
      .prepare(`SELECT ${column} AS value FROM archive_dynamics WHERE id=? AND owner_uin=?`)
      .get(Math.trunc(id), ownerUin) as Record<string, unknown> | undefined;
  } catch (error) {
    throw new Error(`${failurePrefix}：${describeError(error)}`);
  }
  if (row === undefined) throw new Error(missingMessage);
  const value = row.value;
  return typeof value === "string" ? value : null;
}

/** 读取动态的图片字段, 缺少该动态时报与基准一致的错误 */
export function readArchivedPicturesJson(db: DatabaseSync, ownerUin: string, id: number): string | null {
  return readDynamicJson(db, ownerUin, id, "pictures_json", "当前账号中不存在这条图片归档", "读取图片归档失败");
}

/** 读取动态的视频字段, 缺少该动态时报与基准一致的错误 */
export function readArchivedVideoJson(db: DatabaseSync, ownerUin: string, id: number): string | null {
  return readDynamicJson(db, ownerUin, id, "video_json", "当前账号中不存在这条视频归档", "读取视频归档失败");
}

/**
 * 媒体时光轴查询, 与基准 list_archived_media 对应
 *
 * 年份列表按动态的本地年份倒序去重; 条目按发布时间与标识升序展开为图片与视频两项,
 * 年份筛选在 SQL 内完成, 分页在展开后按 offset 与 limit 裁剪;
 * 只统计 self 与 other 两类动态, 留言板不进入媒体时光轴
 */
export function listArchivedMedia(
  db: DatabaseSync,
  ownerUin: string,
  limit: number,
  offset: number,
  year: number | null,
): ArchiveMediaPage {
  const yearRows = db
    .prepare(
      `SELECT DISTINCT CAST(strftime('%Y',published_at,'unixepoch','localtime') AS INTEGER) AS year
       FROM archive_dynamics
       WHERE owner_uin=? AND category IN ('self','other')
         AND (pictures_json IS NOT NULL OR video_json IS NOT NULL)
       ORDER BY 1 DESC`,
    )
    .all(ownerUin) as Record<string, unknown>[];
  const years: number[] = [];
  for (const row of yearRows) {
    // 时间戳非法的行取不到年份, 与基准 filter_map(Result::ok) 一致地跳过
    if (typeof row.year === "number" && Number.isFinite(row.year)) years.push(Math.trunc(row.year));
  }

  const rows = db
    .prepare(
      `SELECT id,published_at,content,author_uin,author_name,pictures_json,video_json
       FROM archive_dynamics
       WHERE owner_uin=? AND category IN ('self','other')
         AND (pictures_json IS NOT NULL OR video_json IS NOT NULL)
         AND (? IS NULL OR CAST(strftime('%Y',published_at,'unixepoch','localtime') AS INTEGER)=?)
       ORDER BY published_at ASC,id ASC`,
    )
    .all(ownerUin, year, year) as Record<string, unknown>[];

  const all: ArchiveMediaItem[] = [];
  for (const row of rows) {
    const id = Math.trunc(Number(row.id ?? 0));
    const publishedAt = Math.trunc(Number(row.published_at ?? 0));
    const content = typeof row.content === "string" ? row.content : null;
    const authorUin = typeof row.author_uin === "string" ? row.author_uin : null;
    const authorName = typeof row.author_name === "string" ? row.author_name : null;
    const picturesJson = typeof row.pictures_json === "string" ? row.pictures_json : null;
    pictureUrls(picturesJson).forEach((url, index) => {
      all.push({
        key: `${id}-photo-${index}`,
        dynamicId: id,
        mediaType: "photo",
        pictureIndex: index,
        url,
        coverUrl: null,
        publishedAt,
        authorUin,
        authorName,
        content,
      });
    });
    const videoJson = typeof row.video_json === "string" ? row.video_json : null;
    const video = videoUrls(videoJson)[0];
    if (video !== undefined) {
      all.push({
        key: `${id}-video`,
        dynamicId: id,
        mediaType: "video",
        pictureIndex: null,
        url: video,
        coverUrl: videoCoverUrl(videoJson),
        publishedAt,
        authorUin,
        authorName,
        content,
      });
    }
  }

  const total = all.length;
  const start = Math.min(Math.max(0, finiteInteger(offset, 0)), total);
  const end = Math.min(start + pageLimit(limit), total);
  return { items: all.slice(start, end), total, years };
}

/** 构造媒体请求头, Cookie 与 Referer 按候选组合取舍, 其余固定 */
function mediaHeaders(
  accept: string,
  userAgent: string,
  cookieHeader: string,
  withCookie: boolean,
  withReferer: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    Accept: accept,
    "Accept-Language": ACCEPT_LANGUAGE,
  };
  if (withCookie) headers.Cookie = cookieHeader;
  if (withReferer) headers.Referer = IMAGE_REFERER;
  return headers;
}

/**
 * 写出图片归档
 *
 * 先写 {文件名}-{唯一后缀}.part 再改名到最终文件, 与基准一致;
 * 改名失败时若目标文件已存在(其他并发请求先写成功)则保留目标并清理临时文件
 */
function writeArchivedImage(
  imageDir: string,
  fileStem: string,
  extension: string,
  bytes: Uint8Array,
): string {
  const target = join(imageDir, `${fileStem}.${extension}`);
  const nonce = process.hrtime.bigint().toString();
  const temporary = join(imageDir, `${fileStem}-${nonce}.part`);
  try {
    writeFileSync(temporary, bytes);
  } catch (error) {
    throw new Error(`写入图片归档失败：${describeError(error)}`);
  }
  try {
    renameSync(temporary, target);
  } catch (error) {
    if (!existsSync(target)) {
      removeFile(temporary);
      throw new Error(`保存图片归档失败：${describeError(error)}`);
    }
    removeFile(temporary);
  }
  return target;
}

/**
 * 加载单张归档图片, 与基准 load_archived_image 对应
 *
 * 命中 {id}-{index}.{扩展名} 缓存直接返回; 否则按该图片的候选地址依次尝试四种请求头组合,
 * 全部失败时抛出带最后一次错误原因的汇总错误
 */
export async function loadArchivedImage(
  request: ArchivedImageRequest,
  id: number,
  pictureIndex: number,
): Promise<string> {
  const fileStem = `${Math.trunc(id)}-${Math.trunc(pictureIndex)}`;
  const cached = existingArchivedImage(request.imageDir, fileStem);
  if (cached !== null) return cached;

  const candidates = pictureUrlCandidates(request.readPicturesJson())[Math.trunc(pictureIndex)];
  if (candidates === undefined || candidates.length === 0) {
    throw new Error("该图片没有保存可用的 QQ 地址");
  }

  const release = await imageDownloadGate.acquire();
  try {
    // 排队期间可能已有并发请求写好了同一张图片, 与基准在这里再查一次
    const rechecked = existingArchivedImage(request.imageDir, fileStem);
    if (rechecked !== null) return rechecked;

    let lastError = "";
    for (const url of candidates) {
      for (const [withCookie, withReferer] of REQUEST_VARIANTS) {
        let bytes: Uint8Array;
        try {
          const response = await fetchRemoteBytes(
            url,
            {
              headers: mediaHeaders(
                IMAGE_ACCEPT,
                request.userAgent,
                request.cookieHeader,
                withCookie,
                withReferer,
              ),
            },
            { timeoutMs: IMAGE_REQUEST_TIMEOUT_MS, maxBytes: IMAGE_MAX_BYTES },
          );
          if (!response.ok) {
            lastError = `HTTP ${response.status}`;
            continue;
          }
          if (response.tooLarge === true) {
            lastError = "图片超过 50 MB 安全限制";
            continue;
          }
          bytes = Buffer.from(response.bytesBase64, "base64");
        } catch (error) {
          lastError = `请求图片失败：${describeError(error)}`;
          continue;
        }
        if (bytes.length > IMAGE_MAX_BYTES) {
          lastError = "图片超过 50 MB 安全限制";
          continue;
        }
        const extension = archivedImageExtension(bytes);
        if (extension === null) {
          lastError = "QQ 返回了非图片内容";
          continue;
        }
        if (isQqMissingImagePlaceholder(bytes)) {
          lastError = "QQ 返回了图片不存在占位图";
          continue;
        }
        return writeArchivedImage(request.imageDir, fileStem, extension, bytes);
      }
    }
    throw new Error(`所有 QQ 图片地址均加载失败：${lastError}`);
  } finally {
    release();
  }
}

/** mp4 判定, 与基准一致地在字节 4 到 12 之间寻找 ftyp 标记 */
export function videoBytesLookLikeMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  for (let offset = 4; offset + 4 <= 12; offset += 1) {
    if (asciiAt(bytes, offset, "ftyp")) return true;
  }
  return false;
}

/**
 * 加载归档视频, 与基准 load_archived_video 对应
 *
 * 缓存文件为 {账号}-{id}.mp4, 大于 1024 字节即视为有效;
 * 地址带时效, 收到 HTTP 403 时提示重新归档刷新签名
 */
export async function loadArchivedVideo(request: ArchivedVideoRequest, id: number): Promise<string> {
  const numericId = Math.trunc(id);
  const cachePath = join(request.videoDir, `${request.ownerUin}-${numericId}.mp4`);
  if (fileSize(cachePath) > MIN_CACHED_VIDEO_BYTES) return cachePath;

  const candidates = videoUrls(request.readVideoJson());
  if (candidates.length === 0) throw new Error("该归档没有可用的视频地址");

  let lastError = "";
  let rejected = false;
  for (const url of candidates) {
    for (const [withCookie, withReferer] of REQUEST_VARIANTS) {
      let response: Awaited<ReturnType<typeof fetchRemoteBytes>>;
      try {
        response = await fetchRemoteBytes(
          url,
          {
            headers: mediaHeaders(
              VIDEO_ACCEPT,
              request.userAgent,
              request.cookieHeader,
              withCookie,
              withReferer,
            ),
          },
          { timeoutMs: VIDEO_REQUEST_TIMEOUT_MS },
        );
      } catch (error) {
        lastError = `请求视频失败：${describeError(error)}`;
        continue;
      }
      if (!response.ok) {
        if (response.status === 403) rejected = true;
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const contentType = response.contentType.toLowerCase();
      const bytes = Buffer.from(response.bytesBase64, "base64");
      if (
        contentType.startsWith("video/") ||
        contentType.includes("octet-stream") ||
        videoBytesLookLikeMp4(bytes)
      ) {
        try {
          writeFileSync(cachePath, bytes);
        } catch (error) {
          throw new Error(`写入视频缓存失败：${describeError(error)}`);
        }
        return cachePath;
      }
      lastError = `QQ 返回了非视频内容（${contentType.length === 0 ? "未知类型" : contentType}）`;
    }
  }
  if (rejected) {
    throw new Error(
      "QQ 拒绝了视频请求（HTTP 403），该归档的视频临时签名可能已经过期，请重新归档以更新视频地址",
    );
  }
  throw new Error(`所有视频地址均加载失败：${lastError}`);
}
