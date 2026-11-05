import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { BatchManager } from "./core/batch-manager";
import { probeFile } from "./core/probe";
import { BatchItem } from "./shared/types";
import { FfmpegProvider } from "./core/ffmpeg-provider";
import { AppUpdater } from "./core/updater";

const APP_USER_MODEL_ID = "com.video-compressor.desktop";

if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

/** Installatiemap (naast de .exe) of de projectmap tijdens ontwikkeling. */
function appDirectory(): string {
  return app.isPackaged ? dirname(app.getPath("exe")) : process.cwd();
}

let activeBatch: BatchManager | null = null;

function requirePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || !isAbsolute(value)) throw new Error(`${name} moet een absoluut bestandspad zijn.`);
  return value;
}

function validateBatchItem(item: BatchItem): void {
  if (!item || typeof item !== "object" || typeof item.id !== "string") throw new Error("Ongeldig batchitem.");
  requirePath(item.inputPath, "Invoerpad");
  if (!item.id || !Number.isFinite(item.metadata.duration) || item.metadata.duration <= 0) throw new Error("Ongeldige batchmetadata.");
  if (!["compress", "convert"].includes(item.settings.mode)) throw new Error("Ongeldige verwerkingsmodus.");
  if (item.settings.mode === "compress" && (!Number.isFinite(item.settings.targetMb) || item.settings.targetMb <= 0)) throw new Error("Doelgrootte moet groter zijn dan 0 MB.");
  if (!["h264", "h265"].includes(item.settings.videoCodec) || !["ultrafast", "fast", "medium", "slow"].includes(item.settings.preset)) throw new Error("Ongeldige compressie-instellingen.");
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280, height: 900, minWidth: 1000, minHeight: 680,
    backgroundColor: "#070b14",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Renderer] Failed to load (${errorCode}): ${errorDescription} - ${validatedURL}`);
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[Renderer] level=${level} ${sourceId}:${line} ${message}`);
  });
  window.loadFile(join(__dirname, "renderer", "index.html"));
  return window;
}

app.whenReady().then(() => {
  const window = createWindow();
  const provider = new FfmpegProvider(join(process.resourcesPath, "ffmpeg"), appDirectory());
  const updater = new AppUpdater();
  let binaryStatus = provider.getStatus();
  const sendBinaryStatus = () => {
    binaryStatus = provider.getStatus();
    window.webContents.send("binaries", binaryStatus);
    if (!binaryStatus.available) window.webContents.send("binary-error", binaryStatus.message);
  };
  const sendUpdateState = () => {
    if (!window.isDestroyed()) window.webContents.send("update-status", updater.getState());
  };
  updater.onChange(() => sendUpdateState());
  updater.start(window);
  window.webContents.on("did-finish-load", () => {
    sendBinaryStatus();
    sendUpdateState();
  });
  ipcMain.handle("app-info", () => ({
    name: app.getName(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    userData: app.getPath("userData"),
    appDirectory: appDirectory()
  }));
  ipcMain.handle("update-status", () => updater.getState());
  ipcMain.handle("update-check", () => updater.check());
  ipcMain.handle("update-download", () => updater.download());
  ipcMain.handle("update-install", () => {
    updater.install();
    return true;
  });
  ipcMain.handle("ffmpeg-status", () => provider.getStatus());
  ipcMain.handle("recheck-ffmpeg", async () => {
    binaryStatus = await provider.detect();
    sendBinaryStatus();
    return binaryStatus;
  });
  ipcMain.handle("select-ffmpeg", async () => {
    const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "FFmpeg executable", extensions: ["exe"] }] });
    if (result.canceled || !result.filePaths[0]) return provider.getStatus();
    binaryStatus = await provider.select(dirname(result.filePaths[0]));
    sendBinaryStatus();
    return binaryStatus;
  });
  ipcMain.handle("install-ffmpeg", async (event) => {
    binaryStatus = await provider.install((percent) => event.sender.send("ffmpeg-install-progress", percent));
    sendBinaryStatus();
    return binaryStatus;
  });
  ipcMain.handle("select-files", async () => (await dialog.showOpenDialog(window, { properties: ["openFile", "multiSelections"], filters: [{ name: "Video", extensions: ["ts", "m2ts", "mp4", "mov", "mkv", "avi"] }] })).filePaths);
  ipcMain.handle("probe", async (_event, filePath: string) => {
    const safePath = requirePath(filePath, "Invoerbestand");
    if (!binaryStatus.available) {
      const size = statSync(safePath).size;
      return { size, duration: 0, width: 0, height: 0, frameRate: 0, videoCodec: "onbekend", audioCodec: null, audioChannels: null, audioSampleRate: null };
    }
    return probeFile(provider.getFfprobePath(), safePath);
  });
  ipcMain.handle("start-batch", async (event, items: BatchItem[], concurrency: number) => {
    if (activeBatch) throw new Error("Er draait al een batch.");
    if (!Array.isArray(items) || items.length === 0) throw new Error("De batch bevat geen bestanden.");
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Paralleliteit moet tussen 1 en 8 liggen.");
    if (!provider.getStatus().available) {
      binaryStatus = await provider.detect();
      sendBinaryStatus();
    }
    if (!provider.getStatus().available) throw new Error("FFmpeg/FFprobe zijn niet beschikbaar. Configureer eerst FFmpeg in Instellingen.");
    const preparedItems = await Promise.all(items.map(async (item) => {
      try {
        if (!item?.id) throw new Error("Ongeldig batchitem.");
        requirePath(item.inputPath, "Invoerpad");
        const metadata = await probeFile(provider.getFfprobePath(), item.inputPath);
        const prepared: BatchItem = { ...item, metadata, status: "queued", error: undefined };
        validateBatchItem(prepared);
        return prepared;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bestand kon niet worden voorbereid.";
        return {
          ...item,
          status: "failed" as const,
          error: message,
          progress: { status: "error" as const, percent: 0, speed: "", etaSeconds: null, bitrate: "", message }
        };
      }
    }));
    activeBatch = new BatchManager(provider.getFfmpegPath(), concurrency);
    try {
      await activeBatch.start(preparedItems, (update) => event.sender.send("batch-update", update));
    } finally {
      activeBatch = null;
    }
  });
  ipcMain.on("cancel-batch", () => activeBatch?.cancelAll());
  ipcMain.on("cancel-item", (_event, id: string) => activeBatch?.cancelItem(id));
  ipcMain.handle("open-file", (_event, filePath: string) => shell.openPath(requirePath(filePath, "Bestand")));
  ipcMain.handle("show-in-folder", (_event, filePath: string) => shell.showItemInFolder(requirePath(filePath, "Pad")));
  ipcMain.handle("save-copy", async (event, filePath: string) => {
    requirePath(filePath, "Bestand");
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, { defaultPath: filePath, filters: [{ name: "MP4 video", extensions: ["mp4"] }] });
    if (!result.canceled && result.filePath) {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(filePath, result.filePath);
      return result.filePath;
    }
    return null;
  });
  void provider.detect().then((status) => {
    binaryStatus = status;
    sendBinaryStatus();
  }).catch((error: Error) => {
    binaryStatus = { ...provider.getStatus(), state: "error", message: `FFmpeg-controle mislukt: ${error.message}` };
    window.webContents.send("binaries", binaryStatus);
    window.webContents.send("binary-error", binaryStatus.message);
  });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
