/**
 * 归档引擎
 *
 * 行为基准为 temp/reference/src-tauri/src/archive.rs 的主流程部分: now, archive_page_delay_ms,
 * set_progress, concise_archive_error, fetch_after_skipped_cursor, start_feed_archive,
 * get_archive_progress, cancel_feed_archive, list_archive_skips, clear_resolved_archive_skips,
 * retry_archive_skip, retry_all_archive_skips
 *
 * 进度与取消标志用模块内单例承载, 等价于原 Rust 版的 ArchiveState
 * 本模块不依赖 electron, 不依赖 node:fs, 数据库文件路径与登录凭证都由命令层注入
 */

import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

import {
  checkpointIsStale,
  clearResolvedArchiveSkips as clearResolvedSkipsInDatabase,
  completeSkipRetry,
  countUnresolvedSkips,
  failSkipRetry,
  knownSkipAdvance,
  listArchiveSkips as listArchiveSkipRows,
  listPendingSkipIds,
  loadCheckpoint,
  loadSkipRetryTarget,
  nowSeconds,
  openArchiveDatabase,
  recordArchiveSkip,
  reserveArchivePage,
  savePage,
  saveRetriedPage,
} from "./archiveDb.js";
import {
  ARCHIVE_INTERVAL_DEFAULT_MS,
  ARCHIVE_INTERVAL_MAX_MS,
  ARCHIVE_INTERVAL_MIN_MS,
  ARCHIVE_SKIP_MAX_OFFSET_ADVANCE,
  FIRST_PAGE_RETRY_ATTEMPTS,
  FIRST_PAGE_RETRY_DELAYS_MS,
} from "./constants.js";
import {
  advanceFeedCursor,
  parseFeedCursor,
  skipProbeOffsets,
  type FeedCursorDetails,
} from "./feedCursor.js";
import {
  feedErrorCanSkip,
  fetchFeeds,
  fetchFeedsOnce,
  type QzoneFeedCredentials,
  type QzoneFeedPage,
} from "./qzoneClient.js";

/** 归档进度状态, 取值与前端 ArchiveStatus 一致 */
export type ArchiveStatus = "idle" | "running" | "completed" | "cancelled" | "limited" | "error";

/** 批量重试异常位置时的实时进度 */
export interface BatchRetryProgress {
  current: number;
  total: number;
  recovered: number;
  failed: number;
  recoveredRecords: number;
}

/** 归档进度快照, 字段名与原 Rust 版的 serde camelCase 输出一致 */
export interface ArchiveProgress {
  status: ArchiveStatus;
  pages: number;
  fetched: number;
  saved: number;
  skipped: number;
  message: string;
  retryAt: number | null;
  batchRetry: BatchRetryProgress | null;
}

/** 异常跳过条目, 字段与原 Rust 版 ArchiveSkipItem 一致, 不含游标原文 */
export interface ArchiveSkipItem {
  id: number;
  pageNumber: number;
  cursorOffset: number;
  offsetAdvance: number;
  baseTime: number;
  error: string;
  skippedAt: number;
  retryCount: number;
  lastRetryAt: number | null;
  resolvedAt: number | null;
  recoveredRecords: number;
}

export interface ArchiveSkipRetryResult {
  success: boolean;
  message: string;
  recoveredRecords: number;
}

export interface ArchiveSkipBatchRetryResult {
  total: number;
  recovered: number;
  failed: number;
  recoveredRecords: number;
}

/**
 * 引擎运行所需的外部输入
 *
 * databaseFile 由命令层从 paths.ts 取得, auth 由命令层包装 core/login.ts 的 qzoneAuth
 */
export interface ArchiveEngineContext {
  databaseFile: string;
  auth: () => QzoneFeedCredentials;
}

/** 频率保护错误前缀, 结束归档时按该前缀判定状态 */
const RATE_LIMIT_PREFIX = "ARCHIVE_RATE_LIMIT:";

/** 频率保护提示, 逐字保留原基准文案 */
const RATE_LIMIT_MESSAGE =
  "为防止接口请求过于频繁，每 10 分钟最多归档 300 页。达到限制后已安全暂停，倒计时结束即可从当前进度继续归档。";

/** 归档状态单例, 等价于 Rust 的 ArchiveState */
interface ArchiveEngineState {
  progress: ArchiveProgress;
  cancel: boolean;
  batchRetrying: boolean;
  batchCancel: boolean;
}

/** 归档循环中会被逐页推进的位置信息 */
interface ArchiveLoopState {
  cursor: string | null;
  resetCheckpointStats: boolean;
  seenCursors: Set<string>;
}

/** 一次跳过探测的结果 */
interface SkipProbeOutcome {
  page: QzoneFeedPage;
  resumeCursor: string;
  offsetAdvance: number;
}

function defaultProgress(): ArchiveProgress {
  return {
    status: "idle",
    pages: 0,
    fetched: 0,
    saved: 0,
    skipped: 0,
    message: "尚未开始归档",
    retryAt: null,
    batchRetry: null,
  };
}

const state: ArchiveEngineState = {
  progress: defaultProgress(),
  cancel: false,
  batchRetrying: false,
  batchCancel: false,
};

/** 修改进度, 与原 Rust 版 set_progress 对应 */
function setProgress(update: (progress: ArchiveProgress) => void): void {
  update(state.progress);
}

/** 取进度快照, 避免调用方持有内部对象 */
function snapshotProgress(): ArchiveProgress {
  const progress = state.progress;
  return {
    ...progress,
    batchRetry: progress.batchRetry === null ? null : { ...progress.batchRetry },
  };
}

/** 异常统一转成短描述, 不携带任何凭证 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 归档请求间隔夹取, 与原 Rust 版的 clamp(2_000, 30_000) 对应 */
function clampArchiveInterval(intervalMs: number): number {
  const value = Number.isFinite(intervalMs) ? Math.trunc(intervalMs) : ARCHIVE_INTERVAL_DEFAULT_MS;
  return Math.min(Math.max(value, ARCHIVE_INTERVAL_MIN_MS), ARCHIVE_INTERVAL_MAX_MS);
}

/**
 * 每页请求前的等待毫秒数, 与原 Rust 版 archive_page_delay_ms 对应
 *
 * 在请求间隔基础上叠加四分之一间隔以内的亚秒抖动, 降低请求节奏的规律性
 */
export function archivePageDelayMs(intervalMs: number): number {
  const interval = clampArchiveInterval(intervalMs);
  const jitterRange = Math.max(Math.floor(interval / 4), 1);
  const subsecondNanos = (Date.now() % 1000) * 1_000_000;
  return interval + (subsecondNanos % (jitterRange + 1));
}

/**
 * 错误摘要, 与原 Rust 版 concise_archive_error 对应
 *
 * 先把连续空白折叠成单个空格, 再按码点截断到 240 个字符, 超长时补省略号
 */
export function conciseArchiveError(error: string): string {
  const normalized = error
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .join(" ");
  const points = Array.from(normalized);
  if (points.length <= 240) return normalized;
  return `${points.slice(0, 240).join("")}…`;
}

/** 频率保护错误, 与 Rust 的 format!("ARCHIVE_RATE_LIMIT:{retry_at}") 对应 */
function rateLimitError(retryAt: number): Error {
  return new Error(`${RATE_LIMIT_PREFIX}${retryAt}`);
}

/** 占用一次分页额度, 达到限制时抛出频率保护错误 */
function reservePage(context: ArchiveEngineContext, ownerUin: string): void {
  const retryAt = withDatabase(context, (db) => reserveArchivePage(db, ownerUin));
  if (retryAt !== undefined) throw rateLimitError(retryAt);
}

/** 打开数据库执行一段逻辑后关闭, 与 Rust 每次 open_database 的用法对应 */
function withDatabase<T>(context: ArchiveEngineContext, run: (db: DatabaseSync) => T): T {
  const db = openArchiveDatabase(context.databaseFile);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** 取首页失败后的退避毫秒数, 对应 Rust 的 first_attempt * 3 秒 */
function firstPageRetryDelayMs(attempt: number): number {
  return FIRST_PAGE_RETRY_DELAYS_MS[attempt - 1] ?? attempt * 3000;
}

/**
 * 首页请求, 与原 Rust 版 start_feed_archive 的首页分支对应
 *
 * 只对可跳过的错误重试, 最多 3 次, 退避 3 秒与 6 秒
 */
async function fetchFirstPageWithRetries(
  credentials: QzoneFeedCredentials,
): Promise<QzoneFeedPage> {
  for (let attempt = 1; attempt <= FIRST_PAGE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await fetchFeeds(credentials, "1", null);
    } catch (error) {
      const message = describeError(error);
      if (!feedErrorCanSkip(message)) throw error;
      if (attempt >= FIRST_PAGE_RETRY_ATTEMPTS) {
        throw new Error(`第一页获取空间动态失败（已重试3次）：${message}`);
      }
      setProgress((progress) => {
        progress.message = `第一页请求失败（${message}），${attempt}/${FIRST_PAGE_RETRY_ATTEMPTS} 次重试中…`;
      });
      await sleep(firstPageRetryDelayMs(attempt));
    }
  }
  throw new Error("第一页获取空间动态失败：未知错误");
}

/**
 * 续传页请求, 与原 Rust 版 start_feed_archive 的游标分支对应
 *
 * 已知的异常位置直接进入跳过探测; 新出现的可跳过错误先登记到待重试列表再探测,
 * 探测失败或频率保护都按原基准向上抛出
 */
async function fetchCursorPage(
  context: ArchiveEngineContext,
  credentials: QzoneFeedCredentials,
  ownerUin: string,
  cursor: string,
  intervalMs: number,
): Promise<{ page: QzoneFeedPage; skippedPage: SkippedPage | null }> {
  const known = knownSkipFor(context, ownerUin, cursor);
  if (known !== null) {
    const outcome = await fetchAfterSkippedCursor(
      context,
      credentials,
      ownerUin,
      cursor,
      known.advance,
      intervalMs,
    );
    return {
      page: outcome.page,
      skippedPage: {
        failedCursor: cursor,
        resumeCursor: outcome.resumeCursor,
        details: known.details,
        offsetAdvance: outcome.offsetAdvance,
        error: known.error,
      },
    };
  }

  try {
    return { page: await fetchFeeds(credentials, "2", cursor), skippedPage: null };
  } catch (error) {
    const message = describeError(error);
    if (!feedErrorCanSkip(message)) throw error;
    let details: FeedCursorDetails;
    try {
      details = parseFeedCursor(cursor);
    } catch (cursorError) {
      throw new Error(`${message}；且无法自动跳过该页：${describeError(cursorError)}`);
    }
    const pageNumber = state.progress.pages + 1;
    withDatabase(context, (db) =>
      recordArchiveSkip(db, ownerUin, {
        cursor,
        resumeCursor: cursor,
        pageNumber,
        cursorOffset: details.offset,
        offsetAdvance: 0,
        baseTime: details.baseTime,
        error: conciseArchiveError(message),
      }),
    );
    const skipCount = withDatabase(context, (db) => countUnresolvedSkips(db, ownerUin));
    setProgress((progress) => {
      progress.skipped = skipCount;
      progress.message = `第 ${pageNumber} 页发生异常，已加入待重试列表，正在寻找后续可恢复位置…`;
    });
    const outcome = await fetchAfterSkippedCursor(
      context,
      credentials,
      ownerUin,
      cursor,
      1,
      intervalMs,
    );
    return {
      page: outcome.page,
      skippedPage: {
        failedCursor: cursor,
        resumeCursor: outcome.resumeCursor,
        details,
        offsetAdvance: outcome.offsetAdvance,
        error: message,
      },
    };
  }
}

/** 已登记的异常跳过位置 */
interface KnownSkip {
  details: FeedCursorDetails;
  error: string;
  advance: number;
}

/** 查询当前位置是否已有未恢复的跳过记录, 游标无法解析时按没有处理 */
function knownSkipFor(
  context: ArchiveEngineContext,
  ownerUin: string,
  cursor: string,
): KnownSkip | null {
  let details: FeedCursorDetails;
  try {
    details = parseFeedCursor(cursor);
  } catch {
    return null;
  }
  const known = withDatabase(context, (db) =>
    knownSkipAdvance(db, ownerUin, details.offset, details.baseTime),
  );
  if (known === undefined) return null;
  return { details, error: known.error, advance: known.offsetAdvance };
}

/** 本轮页面对应的异常位置, 与 Rust 的 skipped_page 元组对应 */
interface SkippedPage {
  failedCursor: string;
  resumeCursor: string;
  details: FeedCursorDetails;
  offsetAdvance: number;
  error: string;
}

/**
 * 从异常位置向后探测可恢复位置, 与原 Rust 版 fetch_after_skipped_cursor 对应
 *
 * 先按 2 的幂次序列向后跳过, 命中后再二分缩小跳过范围;
 * 每次探测都单独占用一页额度, 达到频率保护立即停止
 */
async function fetchAfterSkippedCursor(
  context: ArchiveEngineContext,
  credentials: QzoneFeedCredentials,
  ownerUin: string,
  cursor: string,
  firstAdvance: number,
  intervalMs: number,
): Promise<SkipProbeOutcome> {
  const first = Math.min(Math.max(Math.trunc(firstAdvance), 1), ARCHIVE_SKIP_MAX_OFFSET_ADVANCE);
  let lastError: string | null = null;
  let lastFailedAdvance = Math.max(first - 1, 0);
  let best: SkipProbeOutcome | null = null;

  for (const offsetAdvance of skipProbeOffsets(first)) {
    setProgress((progress) => {
      progress.message = `已记录异常位置，正在尝试从偏移 +${offsetAdvance} 恢复归档…`;
    });
    reservePage(context, ownerUin);
    const candidate = advanceFeedCursor(cursor, offsetAdvance);
    try {
      const page = await fetchFeedsOnce(credentials, "2", candidate);
      best = { page, resumeCursor: candidate, offsetAdvance };
      break;
    } catch (error) {
      const message = describeError(error);
      if (!feedErrorCanSkip(message)) throw error;
      lastFailedAdvance = offsetAdvance;
      lastError = message;
      await sleep(archivePageDelayMs(intervalMs));
    }
  }

  if (best === null) {
    throw new Error(
      `异常位置已保存到待重试列表，但向后探测至偏移 +${ARCHIVE_SKIP_MAX_OFFSET_ADVANCE} 后仍无法取得下一页：${conciseArchiveError(lastError ?? "未知接口错误")}`,
    );
  }

  let low = lastFailedAdvance + 1;
  let high = best.offsetAdvance - 1;
  while (low <= high) {
    const offsetAdvance = low + Math.floor((high - low) / 2);
    setProgress((progress) => {
      progress.message = `已找到可恢复位置，正在缩小跳过范围（偏移 +${offsetAdvance}）…`;
    });
    reservePage(context, ownerUin);
    const candidate = advanceFeedCursor(cursor, offsetAdvance);
    try {
      const page = await fetchFeedsOnce(credentials, "2", candidate);
      best = { page, resumeCursor: candidate, offsetAdvance };
      high = offsetAdvance - 1;
    } catch (error) {
      const message = describeError(error);
      if (!feedErrorCanSkip(message)) throw error;
      low = offsetAdvance + 1;
    }
    await sleep(archivePageDelayMs(intervalMs));
  }
  return best;
}

/**
 * 归档主循环, 与原 Rust 版 start_feed_archive 的循环体对应
 *
 * 正常取完最后一页或收到取消标志时正常返回, 其余情况抛出错误由调用方归类
 */
async function runArchiveLoop(
  context: ArchiveEngineContext,
  credentials: QzoneFeedCredentials,
  ownerUin: string,
  intervalMs: number,
  loop: ArchiveLoopState,
): Promise<void> {
  for (;;) {
    if (state.cancel) return;
    reservePage(context, ownerUin);

    let skippedPage: SkippedPage | null = null;
    let page: QzoneFeedPage;
    if (loop.cursor !== null) {
      const current = loop.cursor;
      const result = await fetchCursorPage(context, credentials, ownerUin, current, intervalMs);
      page = result.page;
      skippedPage = result.skippedPage;
    } else {
      page = await fetchFirstPageWithRetries(credentials);
    }

    const fetched = page.feeds.length;
    let next: string | null = null;
    if (page.hasMore) {
      if (page.attachInfo === null) throw new Error("接口表示还有数据，但未返回分页游标");
      next = page.attachInfo;
    }
    if (next !== null) {
      if (loop.seenCursors.has(next)) {
        throw new Error("检测到重复分页游标，已停止以避免死循环");
      }
      loop.seenCursors.add(next);
    }

    const didSkip = skippedPage !== null;
    if (skippedPage !== null) {
      const pageNumber = state.progress.pages + 1;
      withDatabase(context, (db) =>
        recordArchiveSkip(db, ownerUin, {
          cursor: skippedPage.failedCursor,
          resumeCursor: skippedPage.resumeCursor,
          pageNumber,
          cursorOffset: skippedPage.details.offset,
          offsetAdvance: skippedPage.offsetAdvance,
          baseTime: skippedPage.details.baseTime,
          error: conciseArchiveError(skippedPage.error),
        }),
      );
    }

    const saved = withDatabase(context, (db) =>
      savePage(db, ownerUin, page.feeds, next, loop.resetCheckpointStats),
    );
    loop.resetCheckpointStats = false;
    const skipCount = withDatabase(context, (db) => countUnresolvedSkips(db, ownerUin));
    setProgress((progress) => {
      progress.pages += 1;
      progress.fetched += fetched;
      progress.saved += saved;
      progress.skipped = skipCount;
      progress.message = didSkip
        ? `已跳过 1 个异常位置并继续归档；当前 ${progress.pages} 页，共 ${progress.fetched} 条记录`
        : `已归档 ${progress.pages} 页，共 ${progress.fetched} 条记录`;
    });

    if (!page.hasMore) return;
    loop.cursor = next;
    await sleep(archivePageDelayMs(intervalMs));
  }
}

/** 输出归档任务失败诊断, 只写 stderr, 不写盘且不含凭证 */
function logArchiveTaskError(error: string, progress: ArchiveProgress, ownerUin: string): void {
  const diagnostic = {
    event: "qzone_archive_task_error",
    error,
    pages: progress.pages,
    fetched: progress.fetched,
    saved: progress.saved,
    ownerUin,
  };
  console.error(
    `\n================ QZONE ARCHIVE TASK ERROR ================\n${JSON.stringify(diagnostic, null, 2)}\n================ END QZONE ARCHIVE TASK ERROR ================\n`,
  );
}

/**
 * 开始归档, 与原 Rust 版 start_feed_archive 对应
 *
 * 完整跑完归档循环后以最终进度 resolve; 频率保护按原基准也不算失败, 以 limited 状态 resolve;
 * 其余错误在写入 error 进度后 reject
 */
export async function startFeedArchive(
  context: ArchiveEngineContext,
  intervalMs: number,
): Promise<ArchiveProgress> {
  const interval = clampArchiveInterval(intervalMs);
  if (state.batchRetrying) {
    throw new Error("正在批量重试异常位置，请等待完成或停止后再开始归档");
  }
  if (state.progress.status === "running") {
    throw new Error("已有归档任务正在运行");
  }
  setProgress((progress) => {
    progress.status = "running";
    progress.pages = 0;
    progress.fetched = 0;
    progress.saved = 0;
    progress.skipped = 0;
    progress.message = "正在准备归档…";
    progress.retryAt = null;
    progress.batchRetry = null;
  });
  state.cancel = false;

  // 凭证在状态切到 running 之后获取, 与原基准的失败顺序一致
  const credentials = context.auth();
  const ownerUin = credentials.uin;

  setProgress((progress) => {
    progress.skipped = withDatabase(context, (db) => countUnresolvedSkips(db, ownerUin));
  });
  const checkpoint = withDatabase(context, (db) => loadCheckpoint(db, ownerUin));
  const staleCheckpoint = checkpoint !== undefined && checkpointIsStale(checkpoint, nowSeconds());
  const loop: ArchiveLoopState = {
    cursor: checkpoint !== undefined && !staleCheckpoint ? checkpoint.cursor : null,
    resetCheckpointStats: staleCheckpoint,
    seenCursors: new Set<string>(),
  };
  if (staleCheckpoint) {
    setProgress((progress) => {
      progress.message =
        "上次分页位置已超过 10 分钟，正在从第一页重新校验；已保存记录会自动去重。";
    });
  } else if (checkpoint !== undefined) {
    loop.seenCursors.add(checkpoint.cursor);
    setProgress((progress) => {
      progress.pages = checkpoint.pages;
      progress.fetched = checkpoint.fetched;
      progress.saved = checkpoint.saved;
      progress.message = `已恢复上次进度：${checkpoint.pages} 页，正在继续归档…`;
    });
  }

  let failure: string | null = null;
  try {
    await runArchiveLoop(context, credentials, ownerUin, interval, loop);
  } catch (error) {
    failure = describeError(error);
  }

  if (failure === null && state.cancel) {
    setProgress((progress) => {
      progress.status = "cancelled";
      progress.message = "归档已取消";
      progress.retryAt = null;
    });
  } else if (failure === null) {
    setProgress((progress) => {
      progress.status = "completed";
      progress.message =
        progress.skipped > 0
          ? `归档完成，共保存 ${progress.saved} 条记录；另有 ${progress.skipped} 个异常位置已跳过，可在下方单独重试`
          : `归档完成，共保存 ${progress.saved} 条记录`;
      progress.retryAt = null;
    });
  } else if (failure.startsWith(RATE_LIMIT_PREFIX)) {
    const retryAt = Number(failure.slice(RATE_LIMIT_PREFIX.length));
    setProgress((progress) => {
      progress.status = "limited";
      progress.retryAt = Number.isFinite(retryAt) ? retryAt : null;
      progress.message = RATE_LIMIT_MESSAGE;
    });
  } else {
    logArchiveTaskError(failure, state.progress, ownerUin);
    setProgress((progress) => {
      progress.status = "error";
      progress.message = `归档失败：${conciseArchiveError(failure ?? "")}`;
      progress.retryAt = null;
    });
  }

  const progress = snapshotProgress();
  if (failure !== null && !failure.startsWith(RATE_LIMIT_PREFIX)) throw new Error(failure);
  return progress;
}

/** 取当前归档进度, 与原 Rust 版 get_archive_progress 对应 */
export function getArchiveProgress(): ArchiveProgress {
  return snapshotProgress();
}

/**
 * 取消归档, 与原 Rust 版 cancel_feed_archive 对应
 *
 * 同时设置批量重试的停止标志, 与归档共用一个入口
 */
export function cancelFeedArchive(): void {
  state.cancel = true;
  state.batchCancel = true;
}

/** 重置进度与运行标志, 供删除全部应用数据后回到初始状态, 与原 Rust 版重置 ArchiveState 对应 */
export function resetArchiveProgress(): void {
  state.progress = defaultProgress();
  state.cancel = false;
  state.batchRetrying = false;
  state.batchCancel = false;
}

/** 列出异常跳过记录, 与原 Rust 版 list_archive_skips 对应 */
export function listArchiveSkips(context: ArchiveEngineContext): ArchiveSkipItem[] {
  const ownerUin = context.auth().uin;
  return withDatabase(context, (db) => listArchiveSkipRows(db, ownerUin)).map((row) => ({
    id: row.id,
    pageNumber: row.pageNumber,
    cursorOffset: row.cursorOffset,
    offsetAdvance: row.offsetAdvance,
    baseTime: row.baseTime,
    error: row.error,
    skippedAt: row.skippedAt,
    retryCount: row.retryCount,
    lastRetryAt: row.lastRetryAt,
    resolvedAt: row.resolvedAt,
    recoveredRecords: row.recoveredRecords,
  }));
}

/** 清理已恢复的异常跳过记录, 与原 Rust 版 clear_resolved_archive_skips 对应 */
export function clearResolvedArchiveSkips(context: ArchiveEngineContext): number {
  const ownerUin = context.auth().uin;
  return withDatabase(context, (db) => clearResolvedSkipsInDatabase(db, ownerUin));
}

/**
 * 重试单条异常跳过, 与原 Rust 版 retry_single_skip 对应
 *
 * 已恢复的记录直接返回成功; 频率保护按原基准抛出可识别的错误串;
 * 请求失败只更新错误摘要并返回 success 为假的结果, 不抛错
 */
export async function retryArchiveSkip(
  context: ArchiveEngineContext,
  id: number,
): Promise<ArchiveSkipRetryResult> {
  const credentials = context.auth();
  return retrySingleSkip(context, credentials, credentials.uin, id);
}

async function retrySingleSkip(
  context: ArchiveEngineContext,
  credentials: QzoneFeedCredentials,
  ownerUin: string,
  id: number,
): Promise<ArchiveSkipRetryResult> {
  const target = withDatabase(context, (db) => loadSkipRetryTarget(db, ownerUin, id));
  if (target === undefined) throw new Error("找不到这条异常跳过记录");
  if (target.resolvedAt !== null) {
    return { success: true, message: "该异常位置已经重试成功", recoveredRecords: 0 };
  }
  const retryAt = withDatabase(context, (db) => reserveArchivePage(db, ownerUin));
  if (retryAt !== undefined) throw new Error(`请求频率保护中，请在 ${retryAt} 后重试`);

  const attemptedAt = nowSeconds();
  let page: QzoneFeedPage;
  try {
    page = await fetchFeeds(credentials, "2", target.cursor);
  } catch (error) {
    const summary = conciseArchiveError(describeError(error));
    withDatabase(context, (db) => failSkipRetry(db, ownerUin, id, summary, attemptedAt));
    return { success: false, message: `重试仍然失败：${summary}`, recoveredRecords: 0 };
  }

  const recoveredRecords = page.feeds.length;
  withDatabase(context, (db) => saveRetriedPage(db, ownerUin, page.feeds));
  withDatabase(context, (db) => completeSkipRetry(db, ownerUin, id, recoveredRecords, attemptedAt));
  const remaining = withDatabase(context, (db) => countUnresolvedSkips(db, ownerUin));
  setProgress((progress) => {
    progress.skipped = remaining;
  });
  return {
    success: true,
    message: `重试成功，已恢复 ${recoveredRecords} 条接口记录`,
    recoveredRecords,
  };
}

/** 归档运行期间不允许的重试入口校验, 与原 Rust 版 ensure_archive_idle 对应 */
function ensureArchiveIdle(): void {
  if (state.progress.status === "running") {
    throw new Error("归档任务运行时不能删除数据，请先取消任务");
  }
}

/**
 * 批量重试全部未恢复的异常位置, 与原 Rust 版 retry_all_archive_skips 对应
 *
 * 按跳过时间升序逐条重试, 每轮之间按归档节奏等待并可被停止标志打断;
 * 频率保护或归档任务运行中导致的中断直接结束本轮批量重试
 */
export async function retryAllArchiveSkips(
  context: ArchiveEngineContext,
  intervalMs: number,
): Promise<ArchiveSkipBatchRetryResult> {
  const credentials = context.auth();
  const ownerUin = credentials.uin;
  ensureArchiveIdle();
  if (state.batchRetrying) throw new Error("已有批量重试在进行中");
  state.batchRetrying = true;

  const result: ArchiveSkipBatchRetryResult = {
    total: 0,
    recovered: 0,
    failed: 0,
    recoveredRecords: 0,
  };
  // 原基准只在正常结束时复位标志, 这里用 finally 兜底, 避免批量重试中途异常导致入口永久锁死
  try {
    const pendingIds = withDatabase(context, (db) => listPendingSkipIds(db, ownerUin));
    result.total = pendingIds.length;
    state.batchCancel = false;
    for (const [index, id] of pendingIds.entries()) {
      if (state.batchCancel) break;
      reportBatchProgress(index + 1, result);
      try {
        const outcome = await retrySingleSkip(context, credentials, ownerUin, id);
        if (outcome.success) {
          result.recovered += 1;
          result.recoveredRecords += outcome.recoveredRecords;
        } else {
          result.failed += 1;
        }
        reportBatchProgress(index + 1, result);
      } catch (error) {
        const message = describeError(error);
        if (message.startsWith("请求频率保护中") || message.startsWith("归档任务运行中")) break;
        result.failed += 1;
        reportBatchProgress(index + 1, result);
      }
      /*
       * 与归档任务保持一致的节奏, 避免批量重试触发频率保护;
       * 分片等待让停止重试能在当前请求结束后立即生效
       */
      let remaining = archivePageDelayMs(intervalMs);
      while (remaining > 0) {
        if (state.batchCancel) break;
        const slice = Math.min(remaining, 200);
        await sleep(slice);
        remaining -= slice;
      }
    }
  } finally {
    state.batchRetrying = false;
    state.batchCancel = false;
    setProgress((progress) => {
      progress.batchRetry = null;
    });
  }
  return result;
}

/** 写入批量重试进度 */
function reportBatchProgress(current: number, result: ArchiveSkipBatchRetryResult): void {
  setProgress((progress) => {
    progress.batchRetry = {
      current,
      total: result.total,
      recovered: result.recovered,
      failed: result.failed,
      recoveredRecords: result.recoveredRecords,
    };
  });
}
