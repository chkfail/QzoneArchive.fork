/**
 * 归档媒体与导出命令
 *
 * 命令层只负责 Electron 边界: 数据库文件与图片, 视频目录取自 paths.ts,
 * 登录凭证取自 core/login.ts; 媒体加载与 HTML 生成都在 core 内实现, 便于普通 Node 下自测
 * 数据库句柄按需开合: 图片与视频命中磁盘缓存时不触碰数据库, 与基准的局部作用域一致
 */
import type { DatabaseSync } from "node:sqlite";
import { openArchiveDatabase } from "../core/archiveDb.js";
import { exportArchivedHtml } from "../core/archiveExport.js";
import {
  listArchivedMedia,
  loadArchivedImage,
  loadArchivedVideo,
  readArchivedPicturesJson,
  readArchivedVideoJson,
} from "../core/archiveMedia.js";
import { qzoneAuth } from "../core/login.js";
import { defineCommand } from "../ipc.js";
import { databaseFile, imageDirectory, videoDirectory } from "../paths.js";

function withDatabase<T>(run: (db: DatabaseSync) => T): T {
  const db = openArchiveDatabase(databaseFile());
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** 归档标识, 非法值直接报错, 与原命令的整数入参约束一致 */
function archiveId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("归档标识无效");
  return Math.trunc(parsed);
}

/** 图片在动态中的序号, 非法值按 0 处理 */
function pictureIndex(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/** 年份筛选, 缺省或非法值表示不筛选 */
function optionalYear(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export function registerArchiveMediaCommands(): void {
  defineCommand("list_archived_media", (args) => {
    const owner = qzoneAuth().uin;
    return withDatabase((db) =>
      listArchivedMedia(
        db,
        owner,
        Number(args.limit ?? 60),
        Number(args.offset ?? 0),
        optionalYear(args.year),
      ),
    );
  });

  defineCommand("load_archived_image", async (args) => {
    const auth = qzoneAuth();
    const id = archiveId(args.id);
    return loadArchivedImage(
      {
        // 图片归档目录按账号区分, 与基准的 images/<uin> 布局一致
        imageDir: imageDirectory(auth.uin),
        userAgent: auth.userAgent,
        cookieHeader: auth.cookieHeader,
        readPicturesJson: () => withDatabase((db) => readArchivedPicturesJson(db, auth.uin, id)),
      },
      id,
      pictureIndex(args.pictureIndex),
    );
  });

  defineCommand("load_archived_video", async (args) => {
    const auth = qzoneAuth();
    const id = archiveId(args.id);
    return loadArchivedVideo(
      {
        ownerUin: auth.uin,
        videoDir: videoDirectory(),
        userAgent: auth.userAgent,
        cookieHeader: auth.cookieHeader,
        readVideoJson: () => withDatabase((db) => readArchivedVideoJson(db, auth.uin, id)),
      },
      id,
    );
  });

  defineCommand("export_archived_html", (args) => {
    const owner = qzoneAuth().uin;
    const category = String(args.category ?? "");
    const ids = Array.isArray(args.ids) ? args.ids.map((value) => archiveId(value)) : null;
    return withDatabase((db) => exportArchivedHtml(db, owner, category, ids));
  });
}
