/**
 * 归档引擎命令
 *
 * 命令层只负责 Electron 边界: 数据库文件路径取自 paths.ts, 登录凭证取自 core/login.ts,
 * 归档逻辑全部在 core/archiveEngine.ts 中实现, 便于在普通 Node 下自测
 */
import {
  cancelFeedArchive,
  clearResolvedArchiveSkips,
  getArchiveProgress,
  listArchiveSkips,
  retryAllArchiveSkips,
  retryArchiveSkip,
  startFeedArchive,
  type ArchiveEngineContext,
} from "../core/archiveEngine.js";
import { ARCHIVE_INTERVAL_DEFAULT_MS } from "../core/constants.js";
import { qzoneAuth } from "../core/login.js";
import type { QzoneFeedCredentials } from "../core/qzoneClient.js";
import { defineCommand } from "../ipc.js";
import { databaseFile } from "../paths.js";

/** 把登录模块的凭证视图映射成互动列表客户端需要的形状 */
function feedCredentials(): QzoneFeedCredentials {
  const auth = qzoneAuth();
  return {
    uin: auth.uin,
    gTk: auth.gTk,
    cookies: auth.cookieHeader,
    userAgent: auth.userAgent,
  };
}

/** 引擎需要的运行输入, 数据路径与凭证都在调用时解析 */
function engineContext(): ArchiveEngineContext {
  return { databaseFile: databaseFile(), auth: feedCredentials };
}

/** 请求间隔按毫秒取整, 缺省或非法值回落到默认间隔 */
function requestIntervalMs(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : ARCHIVE_INTERVAL_DEFAULT_MS;
}

/** 异常跳过记录标识, 非法值直接报错, 与原命令的整数入参约束一致 */
function skipId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("异常跳过记录标识无效");
  return Math.trunc(parsed);
}

export function registerArchiveEngineCommands(): void {
  defineCommand("start_feed_archive", (args) =>
    startFeedArchive(engineContext(), requestIntervalMs(args.intervalMs)),
  );
  defineCommand("get_archive_progress", () => getArchiveProgress());
  defineCommand("cancel_feed_archive", () => {
    cancelFeedArchive();
  });
  defineCommand("list_archive_skips", () => listArchiveSkips(engineContext()));
  defineCommand("clear_resolved_archive_skips", () => clearResolvedArchiveSkips(engineContext()));
  defineCommand("retry_archive_skip", (args) => retryArchiveSkip(engineContext(), skipId(args.id)));
  defineCommand("retry_all_archive_skips", (args) =>
    retryAllArchiveSkips(engineContext(), requestIntervalMs(args.intervalMs)),
  );
}
