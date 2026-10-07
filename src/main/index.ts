/**
 * Electron 主进程入口
 *
 * 启动顺序有约束: 协议特权注册与 Electron 落盘路径重定向必须在 app ready 之前完成
 */
import { app, BrowserWindow } from "electron";
import { registerAppCommands } from "./commands/app.js";
import { registerArchiveEngineCommands } from "./commands/archiveEngine.js";
import { registerArchiveMediaCommands } from "./commands/archiveMedia.js";
import { registerArchiveQueryCommands, setArchiveIdleProbe } from "./commands/archiveQuery.js";
import { registerBrowserCommands } from "./commands/browser.js";
import { registerFileCommands } from "./commands/files.js";
import { registerLoginCommands } from "./commands/login.js";
import { registerNetCommands } from "./commands/net.js";
import { registerQzoneFeedCommands } from "./commands/qzoneFeed.js";
import { registerRecycleCommands } from "./commands/recycle.js";
import { getArchiveProgress } from "./core/archiveEngine.js";
import { installCommandRouter } from "./ipc.js";
import { dataRoot, redirectElectronPaths } from "./paths.js";
import { handleFileScheme, registerFileScheme } from "./protocol.js";
import { runSmokeTest } from "./smoke.js";
import { createMainWindow } from "./windows.js";

/*
 * 控制台输出兜底: 应用脱离终端运行时 stdout 与 stderr 可能是已关闭的管道,
 * 不吞掉 EPIPE 会让任何 console 输出炸成未捕获异常
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

registerFileScheme();
redirectElectronPaths();

installCommandRouter();
registerAppCommands();
registerFileCommands();
registerBrowserCommands();
registerLoginCommands();
registerNetCommands();
registerQzoneFeedCommands();
registerArchiveEngineCommands();
registerArchiveMediaCommands();
registerArchiveQueryCommands();
setArchiveIdleProbe(() => getArchiveProgress().status !== "running");
registerRecycleCommands();

console.log(`[main] 数据根目录: ${dataRoot()}`);

void app.whenReady().then(() => {
  handleFileScheme();
  const window = createMainWindow();
  if (process.env.QZA_SMOKE === "1") void runSmokeTest(window);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
