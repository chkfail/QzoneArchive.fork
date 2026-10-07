/**
 * 归档记录解析
 *
 * 行为基准为 temp/reference/src-tauri/src/archive.rs 的解析部分: text_at, stable_feed_hash,
 * parse_feed, save_original_dynamic 的字段判定, comment_from_values, reply_from_value, merge_comments
 * 以及图片与视频地址提取
 * 本模块是纯函数层, 不依赖 electron, 不依赖 node:fs, 也不直接读写数据库,
 * 落库写入由 archiveDb 调用本模块的解析结果完成
 */

/** JSON 对象判定, 数组与 null 都不算, 与 serde_json 的 as_object 对应 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 取 JSON 文档中的整数值, 与 serde_json 的 as_i64 对应
 *
 * 非数字或非整数都返回 null, 字符串数字也按原基准不转换
 */
export function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * 按 JSON Pointer 取值, 与 serde_json 的 Value::pointer 对应
 *
 * 对象按键取, 数组只接受纯十进制下标, 其余路径返回 undefined
 */
export function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer.length === 0) return value;
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = value;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(token)) return undefined;
      const index = Number(token);
      if (index >= current.length) return undefined;
      current = current[index];
    } else if (isJsonObject(current)) {
      if (!Object.hasOwn(current, token)) return undefined;
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * 取 JSON Pointer 指向的文本, 与 Rust 版 text_at 对应
 *
 * 非空字符串原样返回, 数字转成十进制字符串, 空串与其余类型都返回 null
 */
export function textAt(value: unknown, pointer: string): string | null {
  const target = jsonPointer(value, pointer);
  if (typeof target === "string") return target.length > 0 ? target : null;
  if (typeof target === "number") return String(target);
  return null;
}

/**
 * 把 JSON 值序列化成紧凑文本, 对象键按升序排列
 *
 * 原基准的 serde_json 默认用 BTreeMap 承载对象, to_string 输出的键序即字典序,
 * 因此这里递归排序以保持落库 JSON 与哈希输入一致
 */
export function stableJsonText(value: unknown): string {
  return JSON.stringify(sortJsonKeys(value));
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (isJsonObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortJsonKeys(value[key]);
    return sorted;
  }
  return value;
}

/** FNV-1a 64 位哈希, 与 Rust 版 stable_feed_hash 逐位一致 */
export function stableFeedHash(value: unknown): bigint {
  const bytes = new TextEncoder().encode(stableJsonText(value));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

/** 哈希的十六进制表示, 与 Rust 的 {:016x} 格式化一致 */
export function formatFeedHash(hash: bigint): string {
  return hash.toString(16).padStart(16, "0");
}

/** 单条互动记录的落库字段, 与 Rust 版 ParsedFeed 对应 */
export interface ParsedFeed {
  feedKey: string;
  cellId: string | null;
  eventType: number;
  eventTime: number;
  title: string | null;
  content: string | null;
  eventSummary: string | null;
  actorUin: string | null;
  actorName: string | null;
  originalAuthorUin: string | null;
  originalAuthorName: string | null;
  pictureCount: number;
  picturesJson: string | null;
  videoJson: string | null;
  commentsJson: string | null;
  rawJson: string;
}

/**
 * 解析单条互动记录, 与 Rust 版 parse_feed 对应
 *
 * feed_key 依次取互动记录键, 原动态键, 由动态标识拼出的稳定键, 最后回落到全量哈希键
 */
export function parseFeed(feed: unknown): ParsedFeed {
  const cellId = textAt(feed, "/original/cell_id/cellid");
  const eventTime = asInteger(jsonPointer(feed, "/comm/time")) ?? 0;
  const eventType = asInteger(jsonPointer(feed, "/comm/subid")) ?? 0;
  const actorUin = textAt(feed, "/userinfo/user/uin");
  const actorLabel = actorUin ?? "unknown";
  const feedKey =
    textAt(feed, "/comm/feedskey") ??
    textAt(feed, "/original/cell_comm/feedskey") ??
    (cellId !== null
      ? `${eventType}:${cellId}:${eventTime}:${actorLabel}`
      : `fallback:${eventType}:${eventTime}:${actorLabel}:${formatFeedHash(stableFeedHash(feed))}`);

  const pictures = jsonPointer(feed, "/original/cell_pic");
  const pictureItems = jsonPointer(pictures, "/picdata/pic");
  const pictureCount = Array.isArray(pictureItems) ? pictureItems.length : 0;
  const video = nonNullValue(jsonPointer(feed, "/original/cell_video"));
  const comments = nonNullValue(jsonPointer(feed, "/original/cell_comment"));

  return {
    feedKey,
    cellId,
    eventType,
    eventTime,
    title: textAt(feed, "/title/title"),
    content: textAt(feed, "/original/cell_summary/summary"),
    eventSummary: textAt(feed, "/summary/summary"),
    actorUin,
    actorName: textAt(feed, "/userinfo/user/nickname"),
    originalAuthorUin: textAt(feed, "/original/cell_userinfo/user/uin"),
    originalAuthorName: textAt(feed, "/original/cell_userinfo/user/nickname"),
    pictureCount,
    picturesJson: pictures === undefined ? null : stableJsonText(pictures),
    videoJson: video === undefined ? null : stableJsonText(video),
    commentsJson: comments === undefined ? null : stableJsonText(comments),
    rawJson: stableJsonText(feed),
  };
}

/** 对应 Rust 的 filter(|value| !value.is_null()), null 与缺失都视为没有该字段 */
function nonNullValue(value: unknown): unknown {
  return value === null || value === undefined ? undefined : value;
}

/** 解析 JSON 文本, 失败时返回 undefined, 对应 serde_json::from_str(...).ok() */
export function tryParseJsonText(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 归档回复, 与 Rust 版 ArchiveReply 的 camelCase 输出对应 */
export interface ArchiveReply {
  uin: string | null;
  nickname: string | null;
  replyToUin: string | null;
  replyToNickname: string | null;
  content: string;
  createdAt: number;
}

/**
 * 归档评论
 *
 * commentId 在原基准中带 serde(skip) 不进入输出, 这里保留以支撑聚合去重
 */
export interface ArchiveComment {
  commentId: string | null;
  uin: string | null;
  nickname: string | null;
  content: string;
  createdAt: number;
  replies: ArchiveReply[];
}

/** 解析单条回复, 对应 Rust 版 reply_from_value, 缺少正文时返回 null */
export function replyFromValue(value: unknown): ArchiveReply | null {
  const content = textAt(value, "/content");
  if (content === null) return null;
  return {
    uin: textAt(value, "/user/uin") ?? textAt(value, "/replyuser/uin"),
    nickname: textAt(value, "/user/nickname") ?? textAt(value, "/replyuser/nickname"),
    replyToUin:
      textAt(value, "/replyuser/uin") ??
      textAt(value, "/targetuser/uin") ??
      textAt(value, "/target/uin"),
    replyToNickname:
      textAt(value, "/replyuser/nickname") ??
      textAt(value, "/targetuser/nickname") ??
      textAt(value, "/target/nickname"),
    content,
    createdAt: asInteger(jsonPointer(value, "/date")) ?? 0,
  };
}

/** 回复去重比较, 对应 Rust 中按 uin, content, created_at 三元组的比较 */
function sameReply(left: ArchiveReply, right: ArchiveReply): boolean {
  return (
    left.uin === right.uin && left.content === right.content && left.createdAt === right.createdAt
  );
}

/** 取数组字段, 非数组按空列表处理, 对应原基准的 and_then(as_array).into_iter().flatten() */
function arrayField(value: unknown, ...pointers: string[]): unknown[] {
  let current = value;
  for (const pointer of pointers) current = jsonPointer(current, pointer);
  return Array.isArray(current) ? current : [];
}

/**
 * 由互动记录的评论字段构造评论, 与 Rust 版 comment_from_values 对应
 *
 * 主评论取 main_comment, 主评论下的 replys 与同 commentid 的 comments 项回复合并去重;
 * 回复通知这类记录把回复正文与作者放在互动记录本身, 需要补一条指向最近一条对端回复的回复
 */
export function commentFromValues(
  json: string | null,
  fallbackUin: string | null,
  fallbackName: string | null,
  fallbackContent: string | null,
  fallbackTime: number,
): ArchiveComment {
  const value = tryParseJsonText(json);
  const main = jsonPointer(value, "/main_comment");
  const commentId = textAt(main, "/commentid");
  const mainUin = textAt(main, "/user/uin");
  const mainName = textAt(main, "/user/nickname");
  const mainContent = textAt(main, "/content");
  const mainTime = asInteger(jsonPointer(main, "/date")) ?? fallbackTime;

  const replies: ArchiveReply[] = [];
  for (const item of arrayField(main, "/replys")) {
    const reply = replyFromValue(item);
    if (reply !== null) replies.push(reply);
  }
  if (commentId !== null) {
    for (const comment of arrayField(value, "/comments")) {
      if (textAt(comment, "/commentid") !== commentId) continue;
      for (const item of arrayField(comment, "/replys")) {
        const reply = replyFromValue(item);
        if (reply !== null && !replies.some((candidate) => sameReply(candidate, reply))) {
          replies.push(reply);
        }
      }
    }
  }

  /*
   * 回复通知把被回复的主评论放在 main_comment, 真正的回复正文与作者放在互动记录上;
   * 当主评论作者再次回复时, 回复对象取此前最后一条来自对端的回复
   */
  const isReplyNotification =
    (asInteger(jsonPointer(main, "/replynum")) ?? 0) > 0 &&
    mainUin !== null &&
    fallbackUin !== null &&
    mainContent !== fallbackContent &&
    fallbackTime > mainTime;
  if (isReplyNotification && fallbackContent !== null) {
    const duplicate = replies.some(
      (reply) => reply.uin === fallbackUin && reply.content === fallbackContent,
    );
    if (!duplicate) {
      let target: ArchiveReply | null = null;
      for (const reply of replies) {
        if (reply.uin === fallbackUin || reply.createdAt > fallbackTime) continue;
        if (target === null || reply.createdAt >= target.createdAt) target = reply;
      }
      replies.push({
        uin: fallbackUin,
        nickname: fallbackName,
        replyToUin: target?.uin ?? mainUin,
        replyToNickname: target?.nickname ?? mainName,
        content: fallbackContent,
        createdAt: fallbackTime,
      });
    }
  }

  return {
    commentId,
    uin: mainUin ?? fallbackUin,
    nickname: mainName ?? fallbackName,
    content: mainContent ?? fallbackContent ?? "评论了这条动态",
    createdAt: mainTime,
    replies,
  };
}

/**
 * 合并同一原动态下的多条评论, 与 Rust 版 merge_comments 对应
 *
 * 有 commentid 时按 commentid 合并, 否则按 uin, content, created_at 判定为同一条;
 * 合并时把回复并入已有评论并按时间排序
 */
export function mergeComments(comments: Iterable<ArchiveComment>): ArchiveComment[] {
  const merged: ArchiveComment[] = [];
  for (const comment of comments) {
    const existing = merged.find(
      (candidate) =>
        (comment.commentId !== null && candidate.commentId === comment.commentId) ||
        (candidate.uin === comment.uin &&
          candidate.content === comment.content &&
          candidate.createdAt === comment.createdAt),
    );
    if (existing === undefined) {
      merged.push({ ...comment, replies: sortReplies(comment.replies) });
      continue;
    }
    for (const reply of comment.replies) {
      if (!existing.replies.some((candidate) => sameReply(candidate, reply))) {
        existing.replies.push(reply);
      }
    }
    existing.replies = sortReplies(existing.replies);
  }
  return merged;
}

/** 稳定排序, 与 Rust 的 sort_by_key 一致 */
function sortReplies(replies: ArchiveReply[]): ArchiveReply[] {
  return [...replies].sort((left, right) => left.createdAt - right.createdAt);
}

/**
 * 单张图片的全部候选地址, 与 Rust 版 picture_url_candidates 对应
 *
 * 每张图片内的候选顺序为: photourl 各项的 url, 再补 busi_param 的 -1 项;
 * 以双斜杠开头的地址补全协议, 组内按首次出现去重
 */
export function pictureUrlCandidates(json: string | null): string[][] {
  const value = tryParseJsonText(json);
  const pictures = jsonPointer(value, "/picdata/pic");
  if (!Array.isArray(pictures)) return [];
  const result: string[][] = [];
  for (const picture of pictures) {
    if (!isJsonObject(picture) || !Object.hasOwn(picture, "photourl")) continue;
    const photoUrls = picture["photourl"];
    const entries = Array.isArray(photoUrls)
      ? photoUrls
      : isJsonObject(photoUrls)
        ? Object.values(photoUrls)
        : [];
    const candidates: string[] = [];
    for (const entry of entries) {
      const url = textAt(entry, "/url");
      if (url !== null) candidates.push(url.trim());
    }
    const extra = textAt(picture, "/busi_param/-1");
    if (extra !== null) candidates.push(extra.trim());
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const candidate of candidates) {
      if (candidate.length === 0) continue;
      const url = candidate.startsWith("//") ? `https:${candidate}` : candidate;
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
    if (urls.length > 0) result.push(urls);
  }
  return result;
}

/** 每张图片的首选地址, 与 Rust 版 picture_urls 对应 */
export function pictureUrls(json: string | null): string[] {
  const preferred: string[] = [];
  for (const candidates of pictureUrlCandidates(json)) {
    if (candidates.length > 0) preferred.push(candidates[0]);
  }
  return preferred;
}

/** 视频候选地址, 与 Rust 版 video_urls 对应, 先取 videourl 再取 videourls 各项并去重 */
export function videoUrls(json: string | null): string[] {
  const value = tryParseJsonText(json);
  const urls: string[] = [];
  const single = textAt(value, "/videourl");
  if (single !== null) urls.push(single);
  const many = jsonPointer(value, "/videourls");
  if (isJsonObject(many)) {
    for (const item of Object.values(many)) {
      const url = textAt(item, "/url");
      if (url !== null && !urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

/** 校验归档分类, 与 Rust 版 validate_category 对应, 只接受 self, other, guestbook */
export function validateCategory(category: string): void {
  if (category !== "self" && category !== "other" && category !== "guestbook") {
    throw new Error("无效的归档分类");
  }
}

/** 视频封面地址, 与 Rust 版 video_cover_url 对应 */
export function videoCoverUrl(json: string | null): string | null {
  const value = tryParseJsonText(json);
  const direct = textAt(value, "/coverurl/0/url");
  if (direct !== null) return direct;
  const cover = jsonPointer(value, "/coverurl");
  if (!isJsonObject(cover)) return null;
  for (const item of Object.values(cover)) {
    const url = textAt(item, "/url");
    if (url !== null) return url;
  }
  return null;
}
