/**
 * 归档 HTML 导出
 *
 * 行为基准为 temp/reference/src-tauri/src/archive.rs 的 export_archived_html(2498-2640)
 * 以及它用到的 html_escape(2378), qzone_text_html(2387), archive_items_for_export(2414)
 * 本模块是纯 Node 层, 禁止 import electron: 只生成单文件 HTML 字符串,
 * 写盘由渲染进程经保存对话框完成
 */
import type { DatabaseSync } from "node:sqlite";
import {
  commentFromValues,
  mergeComments,
  pictureUrls,
  validateCategory,
  videoCoverUrl,
  videoUrls,
} from "./archiveParser.js";
import type { ArchiveCommentOutput, ArchiveFeedItem, ArchiveLikeUser } from "./archiveQuery.js";

/** 动态导出查询列, 与基准 archive_items_for_export 的字段顺序一致 */
const EXPORT_COLUMNS = `d.id AS id,d.owner_uin AS owner_uin,d.cell_id AS cell_id,d.published_at AS published_at,
  d.content AS content,d.author_uin AS author_uin,d.author_name AS author_name,
  d.pictures_json AS pictures_json,d.video_json AS video_json,
  (SELECT COUNT(*) FROM archive_feeds f WHERE f.owner_uin=d.owner_uin AND f.cell_id=d.cell_id AND f.event_type=217) AS like_count,
  (SELECT COUNT(*) FROM archive_feeds f WHERE f.owner_uin=d.owner_uin AND f.cell_id=d.cell_id AND f.event_type IN (2,311)) AS comment_count`;

const EXPORT_COMMENTS_SQL = `SELECT comments_json,actor_uin,actor_name,event_summary,event_time FROM archive_feeds
  WHERE owner_uin=? AND cell_id=? AND event_type IN (2,311) ORDER BY event_time ASC`;

const EXPORT_LIKES_SQL = `SELECT actor_uin,actor_name FROM archive_feeds
  WHERE owner_uin=? AND cell_id=? AND event_type=217 ORDER BY event_time ASC`;

/** 提及语法, 与基准 qzone_text_html 的正则逐字符一致 */
const MENTION_PATTERN = /@\{uin:([^,}]+),nick:([^}]+)\}/gu;

/** 导出分类的显示名, 与基准的分支一致 */
const CATEGORY_NAMES: Record<string, string> = {
  self: "本人动态",
  other: "其他动态",
  guestbook: "留言",
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** HTML 转义, 与基准 html_escape 的替换顺序一致, 与号必须最先替换 */
export function htmlEscape(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/**
 * 空间正文转 HTML, 与基准 qzone_text_html 对应
 *
 * 先去掉正文开头的全角或半角冒号与前导空白; 提及语法转成带 QQ 号的 span,
 * 其余文本转义后原样保留换行(展示由样式表的 pre-wrap 决定);
 * 结果为空时给一句占位文案
 */
export function qzoneTextHtml(value: string | null | undefined): string {
  const source = value ?? "";
  const text = source.replace(/^[：:]+/u, "").trimStart();
  let html = "";
  let cursor = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const index = match.index ?? 0;
    html += htmlEscape(text.slice(cursor, index));
    html += `<span class="mention" title="QQ ${htmlEscape(match[1] ?? "")}">@${htmlEscape(match[2] ?? "")}</span>`;
    cursor = index + match[0].length;
  }
  html += htmlEscape(text.slice(cursor));
  if (html.length === 0) return '<span class="muted">该动态没有文字内容</span>';
  return html;
}

/** 组装单条动态的数据, 与基准 archive_items_for_export 的查询与映射对应 */
function exportRowToItem(row: Record<string, unknown>): ArchiveFeedItem {
  const videoJson = text(row.video_json);
  const urls = videoUrls(videoJson);
  return {
    id: integer(row.id),
    ownerUin: String(row.owner_uin ?? ""),
    cellId: String(row.cell_id ?? ""),
    publishedAt: integer(row.published_at),
    content: text(row.content),
    authorUin: text(row.author_uin),
    authorName: text(row.author_name),
    pictureUrls: pictureUrls(text(row.pictures_json)),
    videoUrl: urls.length > 0 ? urls[0] : null,
    videoUrls: urls,
    videoCoverUrl: videoCoverUrl(videoJson),
    likeCount: integer(row.like_count),
    commentCount: integer(row.comment_count),
    likes: [],
    comments: [],
  };
}

/**
 * 取某分类下的导出条目, 与基准 archive_items_for_export 对应
 *
 * selectedIds 非空时先按标识筛选再补互动, 评论与点赞都按 cell_id 二次查询,
 * 顺序分别是 event_time 升序的时间顺序
 */
export function archiveItemsForExport(
  db: DatabaseSync,
  ownerUin: string,
  category: string,
  selectedIds: ReadonlySet<number> | null,
): ArchiveFeedItem[] {
  let rows: Record<string, unknown>[];
  try {
    rows = db
      .prepare(
        `SELECT ${EXPORT_COLUMNS} FROM archive_dynamics d
         WHERE d.owner_uin=? AND d.category=? ORDER BY d.published_at ASC`,
      )
      .all(ownerUin, category) as Record<string, unknown>[];
  } catch (error) {
    throw new Error(`查询导出内容失败：${describeError(error)}`);
  }
  const items = rows.map(exportRowToItem);
  if (selectedIds !== null) {
    const kept = items.filter((item) => selectedIds.has(item.id));
    items.length = 0;
    items.push(...kept);
  }

  for (const item of items) {
    let commentRows: Record<string, unknown>[];
    try {
      commentRows = db
        .prepare(EXPORT_COMMENTS_SQL)
        .all(item.ownerUin, item.cellId) as Record<string, unknown>[];
    } catch (error) {
      throw new Error(`查询导出评论失败：${describeError(error)}`);
    }
    const comments: ArchiveCommentOutput[] = mergeComments(
      commentRows.map((row) =>
        commentFromValues(
          text(row.comments_json),
          text(row.actor_uin),
          text(row.actor_name),
          text(row.event_summary),
          integer(row.event_time),
        ),
      ),
    ).map((comment) => ({
      uin: comment.uin,
      nickname: comment.nickname,
      content: comment.content,
      createdAt: comment.createdAt,
      replies: comment.replies,
    }));
    item.comments = comments;

    let likeRows: Record<string, unknown>[];
    try {
      likeRows = db
        .prepare(EXPORT_LIKES_SQL)
        .all(item.ownerUin, item.cellId) as Record<string, unknown>[];
    } catch (error) {
      throw new Error(`查询导出点赞用户失败：${describeError(error)}`);
    }
    const likes: ArchiveLikeUser[] = likeRows.map((row) => ({
      uin: text(row.actor_uin),
      nickname: text(row.actor_name),
    }));
    item.likes = likes;
  }
  return items;
}

/** 昵称优先, 其次 QQ 号, 都缺时用给定的兜底文案 */
function displayName(nickname: string | null, uin: string | null, fallback: string): string {
  return nickname ?? uin ?? fallback;
}

/** 组装单条动态的卡片, 与基准 export_archived_html 的拼装顺序逐段一致 */
function renderCard(item: ArchiveFeedItem): string {
  const author = displayName(item.authorName, item.authorUin, "QQ 用户");
  const uin = item.authorUin ?? "0";
  const parts: string[] = [];
  parts.push(
    '<article class="card"><header><img class="avatar" src="https://qlogo2.store.qq.com/qzone/',
    htmlEscape(uin),
    "/",
    htmlEscape(uin),
    '/50"><div><strong>',
    htmlEscape(author),
    "</strong><small>",
  );
  if (item.authorUin !== null) {
    parts.push("QQ ", htmlEscape(item.authorUin), " · ");
  }
  parts.push(
    '<time data-time="',
    item.publishedAt.toString(),
    '"></time></small></div></header><div class="content">',
    qzoneTextHtml(item.content),
    "</div>",
  );
  if (item.pictureUrls.length > 0) {
    parts.push('<div class="pictures">');
    for (const url of item.pictureUrls) {
      parts.push(
        '<a href="',
        htmlEscape(url),
        '" target="_blank"><img loading="lazy" referrerpolicy="no-referrer" src="',
        htmlEscape(url),
        '"></a>',
      );
    }
    parts.push("</div>");
  }
  if (item.videoUrl !== null) {
    parts.push(
      '<p><a class="video" href="',
      htmlEscape(item.videoUrl),
      '" target="_blank">▶ 查看视频</a></p>',
    );
  }
  parts.push('<div class="stats">');
  if (item.likes.length > 0) {
    parts.push("♥ ");
    const names = item.likes
      .slice(0, 10)
      .map((like) => htmlEscape(displayName(like.nickname, like.uin, "QQ用户")));
    parts.push(names.join("、"));
    if (item.likes.length > 10) {
      parts.push(" 等 ", item.likeCount.toString(), " 人赞了");
    } else {
      parts.push(" 赞了");
    }
  }
  parts.push("　💬 ", item.commentCount.toString(), " 条评论</div>");
  if (item.comments.length > 0) {
    parts.push('<section class="comments">');
    for (const comment of item.comments) {
      const commentName = displayName(comment.nickname, comment.uin, "QQ 用户");
      parts.push(
        '<div class="comment"><div class="comment-meta"><b>',
        htmlEscape(commentName),
        "</b> 评论于 <time data-time=\"",
        comment.createdAt.toString(),
        '"></time></div>',
        qzoneTextHtml(comment.content),
      );
      if (comment.replies.length > 0) {
        parts.push('<div class="replies">');
        for (const reply of comment.replies) {
          const replyName = displayName(reply.nickname, reply.uin, "QQ 用户");
          const replyTo = displayName(reply.replyToNickname, reply.replyToUin, commentName);
          parts.push(
            '<div><div class="comment-meta"><b>',
            htmlEscape(replyName),
            "</b> 回复 ",
            htmlEscape(replyTo),
            ' · <time data-time="',
            reply.createdAt.toString(),
            '"></time></div>',
            qzoneTextHtml(reply.content),
            "</div>",
          );
        }
        parts.push("</div>");
      }
      parts.push("</div>");
    }
    parts.push("</section>");
  }
  parts.push("</article>");
  return parts.join("");
}

/** 单文件导出页的外壳, 与基准的模板字符串逐段一致 */
function exportPageHtml(categoryName: string, ownerUin: string, cards: string, count: number): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QQ空间归档 - ${categoryName}</title><style>*{box-sizing:border-box}body{margin:0;background:#f3f6fb;color:#243247;font:14px/1.7 system-ui,-apple-system,"Microsoft YaHei",sans-serif}main{width:min(820px,calc(100% - 24px));margin:30px auto}h1{margin:0}.intro{color:#758298;margin:0 0 20px}.card{background:#fff;border:1px solid #e5eaf2;border-radius:16px;padding:20px;margin:14px 0;box-shadow:0 8px 25px #2038580b}header{display:flex;gap:11px;align-items:center}.avatar{width:44px;height:44px;border-radius:50%}header strong,header small{display:block}small,.muted,.stats{color:#7e899a}.content{margin:14px 0;white-space:pre-wrap;overflow-wrap:anywhere}.mention,a{color:#2684ff}.pictures{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.pictures img{display:block;width:100%;height:210px;object-fit:cover;border-radius:8px}.video{display:inline-block;padding:7px 12px;background:#edf5ff;border-radius:9px;text-decoration:none}.stats{margin-top:12px}.comments{margin-top:12px;padding:12px;background:#f6f8fb;border-radius:10px}.comment{margin:8px 0}.comment-meta{margin-bottom:3px;color:#7e899a;font-size:11px}.comment-meta b{color:#2684ff}.replies{margin:6px 0 0 18px;padding:7px 10px;border-left:2px solid #c9dcf6;background:#fff;border-radius:0 7px 7px 0}@media(max-width:600px){main{margin:16px auto}.card{padding:15px}.pictures img{height:125px}}</style></head><body><main><h1>QQ空间归档 · ${categoryName}</h1><p class="intro">账号 ${htmlEscape(ownerUin)} · 共 ${count} 条 · 导出时间 <span id="export-time"></span></p>${cards}</main><script>document.querySelector('#export-time').textContent=new Date().toLocaleString();document.querySelectorAll('time[data-time]').forEach(e=>e.textContent=new Date(Number(e.dataset.time)*1000).toLocaleString());</script></body></html>`;
}

/**
 * 生成归档导出 HTML, 与基准 export_archived_html 对应
 *
 * ids 为 null 时导出该分类全部动态, 为空数组时按基准报"请先选择需要导出的归档";
 * 该分类没有可导出内容时报"当前分类没有可以导出的归档"
 */
export function exportArchivedHtml(
  db: DatabaseSync,
  ownerUin: string,
  category: string,
  ids: readonly number[] | null,
): string {
  validateCategory(category);
  const selected = ids === null ? null : new Set(ids.map((value) => Math.trunc(value)));
  if (selected !== null && selected.size === 0) throw new Error("请先选择需要导出的归档");
  const items = archiveItemsForExport(db, ownerUin, category, selected);
  if (items.length === 0) throw new Error("当前分类没有可以导出的归档");
  const categoryName = CATEGORY_NAMES[category] ?? "留言";
  const cards = items.map(renderCard).join("");
  return exportPageHtml(categoryName, ownerUin, cards, items.length);
}
