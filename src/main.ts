import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { BatchManager } from "./core/batch-manager";
import { computeAdaptiveConcurrency, maxPixelsInBatch } from "./core/concurrency";
import { selectEncoder } from "./core/encoders";
import { probeFile } from "./core/probe";
import { readSystemResources } from "./core/system-resources";
import { cleanupStaleWorkDirs } from "./core/temp-cleanup";
import { BatchItem, BatchRuntimeInfo } from "./shared/types";
import { FfmpegProvider } from "./core/ffmpeg-provider";
import { AppUpdater } from "./core/updater";

type ThemeSource = "system" | "light" | "dark";

function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#202020" : "#F3F3F3";
}

const APP_USER_MODEL_ID = "com.video-compressor.desktop";
const SHORTCUT_NAME = "Video Compressor.lnk";

if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

/** Installatiemap (naast de .exe) of de projectmap tijdens ontwikkeling. */
function appDirectory(): string {
  return app.isPackaged ? dirname(app.getPath("exe")) : process.cwd();
}

/**
 * Stille NSIS-updates laten Startmenu-/bureaubladsnelkoppelingen soms weg.
 * Herstel ze bij elke start van de geïnstalleerde app.
 */
function ensureWindowsShortcuts(): void {
  if (process.platform !== "win32" || !app.isPackaged) return;
  const exePath = app.getPath("exe");
  const options = {
    target: exePath,
    cwd: dirname(exePath),
    description: "Video Compressor",
    icon: exePath,
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID
  };
  const shortcuts = [
    join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", SHORTCUT_NAME),
    join(app.getPath("desktop"), SHORTCUT_NAME)
  ];
  for (const shortcutPath of shortcuts) {
    try {
      if (existsSync(shortcutPath)) {
        shell.writeShortcutLink(shortcutPath, "update", options);
      } else {
        shell.writeShortcutLink(shortcutPath, "create", options);
      }
    } catch (error) {
      console.warn(`[Shortcuts] Kon snelkoppeling niet schrijven: ${shortcutPath}`, error);
    }
  }
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
  if (!["h264", "h265"].includes(item.settings.videoCodec)) throw new Error("Ongeldige compressie-instellingen.");
  if (!["ultrafast", "veryfast", "faster", "fast", "medium", "slow"].includes(item.settings.preset)) throw new Error("Ongeldige compressie-instellingen.");
  const preference = item.settings.encoderPreference ?? "auto";
  if (!["auto", "cpu", "nvidia", "intel", "amd"].includes(preference)) throw new Error("Ongeldige encoderkeuze.");
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280, height: 900, minWidth: 1100, minHeight: 700,
    backgroundColor: windowBackground(),
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  window.once("ready-to-show", () => window.show());
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
  ensureWindowsShortcuts();
  const staleWork = cleanupStaleWorkDirs();
  if (staleWork.removed.length || staleWork.failed.length) {
    console.log(`[TempCleanup] scanned=${staleWork.scanned} removed=${staleWork.removed.length} failed=${staleWork.failed.length}`);
  }
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
    appDirectory: appDirectory(),
    electron: process.versions.electron
  }));
  ipcMain.handle("get-theme-source", () => nativeTheme.themeSource as ThemeSource);
  ipcMain.handle("set-theme-source", (_event, source: ThemeSource) => {
    if (source !== "system" && source !== "light" && source !== "dark") throw new Error("Ongeldige thema-instelling.");
    nativeTheme.themeSource = source;
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      browserWindow.setBackgroundColor(windowBackground());
    }
    return nativeTheme.themeSource as ThemeSource;
  });
  nativeTheme.on("updated", () => {
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      browserWindow.setBackgroundColor(windowBackground());
    }
  });
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
    if (!Number.isInteger(concurrency) || concurrency < 0 || concurrency > 8) throw new Error("Paralleliteit moet tussen 0 (auto) en 8 liggen.");
    if (!provider.getStatus().available) {
      binaryStatus = await provider.detect();
      sendBinaryStatus();
    }
    if (!provider.getStatus().available) throw new Error("FFmpeg/FFprobe zijn niet beschikbaar. Configureer eerst FFmpeg in Instellingen.");
    const ffmpegStatus = provider.getStatus();
    const preparedItems = await Promise.all(items.map(async (item) => {
      try {
        if (!item?.id) throw new Error("Ongeldig batchitem.");
        requirePath(item.inputPath, "Invoerpad");
        const metadata = await probeFile(provider.getFfprobePath(), item.inputPath);
        const prepared: BatchItem = { ...item, metadata, status: "queued", error: undefined };
        validateBatchItem(prepared);
        if (prepared.settings.videoCodec === "h265" && !ffmpegStatus.codecs.h265) {
          throw new Error("H.265 (libx265) is niet beschikbaar in de huidige FFmpeg-installatie. Kies H.264.");
        }
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
    const queuedItems = preparedItems.filter((item) => item.status === "queued");
    const sample = queuedItems[0];
    const preference = sample?.settings.encoderPreference ?? "auto";
    const codec = sample?.settings.videoCodec ?? "h264";
    const selected = selectEncoder(preference, codec, ffmpegStatus.hardware);
    const resources = await readSystemResources();
    const concurrencyMode = concurrency === 0 ? "auto" as const : "manual" as const;
    const effectiveConcurrency = concurrency === 0
      ? computeAdaptiveConcurrency({
          family: selected.family,
          maxPixels: maxPixelsInBatch(queuedItems),
          resources,
          maxConcurrency: 8
        })
      : concurrency;
    const runtime: BatchRuntimeInfo = {
      concurrency: effectiveConcurrency,
      concurrencyMode,
      encoderFamily: selected.family,
      encoderLabel: selected.label
    };
    activeBatch = new BatchManager(provider.getFfmpegPath(), effectiveConcurrency, {
      hardware: ffmpegStatus.hardware,
      runtime
    });
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
