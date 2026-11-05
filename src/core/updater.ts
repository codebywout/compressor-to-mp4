import { BrowserWindow, app } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";

export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
  message: string;
  releaseNotes: string | null;
}

type UpdateListener = (state: UpdateState) => void;

function notesToText(notes: UpdateInfo["releaseNotes"]): string | null {
  if (!notes) return null;
  if (typeof notes === "string") return notes.trim() || null;
  return notes.map((entry) => entry.note).filter(Boolean).join("\n").trim() || null;
}

export class AppUpdater {
  private state: UpdateState;
  private listener: UpdateListener | null = null;
  private started = false;

  constructor() {
    this.state = {
      status: app.isPackaged ? "idle" : "disabled",
      currentVersion: app.getVersion(),
      availableVersion: null,
      percent: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0,
      message: app.isPackaged ? "Nog niet gecontroleerd." : "Updates werken alleen in de geïnstalleerde app.",
      releaseNotes: null
    };

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on("checking-for-update", () => {
      this.patch({ status: "checking", message: "GitHub Releases controleren…", percent: 0 });
    });
    autoUpdater.on("update-available", (info) => {
      this.patch({
        status: "available",
        availableVersion: info.version,
        message: `Versie ${info.version} is beschikbaar.`,
        releaseNotes: notesToText(info.releaseNotes)
      });
    });
    autoUpdater.on("update-not-available", () => {
      this.patch({
        status: "not-available",
        availableVersion: null,
        message: `Je hebt de nieuwste versie (${app.getVersion()}).`,
        percent: 0,
        releaseNotes: null
      });
    });
    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      this.patch({
        status: "downloading",
        percent: Math.max(0, Math.min(100, progress.percent)),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
        message: `Update downloaden… ${Math.round(progress.percent)}%`
      });
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.patch({
        status: "downloaded",
        availableVersion: info.version,
        percent: 100,
        message: `Versie ${info.version} is gedownload. Herstart om te installeren.`,
        releaseNotes: notesToText(info.releaseNotes)
      });
    });
    autoUpdater.on("error", (error) => {
      this.patch({
        status: "error",
        message: error?.message ? `Update mislukt: ${error.message}` : "Update mislukt.",
        percent: 0
      });
    });
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  onChange(listener: UpdateListener): void {
    this.listener = listener;
    listener(this.getState());
  }

  start(window: BrowserWindow): void {
    if (this.started || !app.isPackaged) return;
    this.started = true;
    const schedule = () => {
      setTimeout(() => {
        void this.check().catch(() => undefined);
      }, 4_000);
    };
    if (window.webContents.isLoading()) {
      window.webContents.once("did-finish-load", schedule);
    } else {
      schedule();
    }
  }

  async check(): Promise<UpdateState> {
    if (!app.isPackaged) return this.getState();
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.patch({
        status: "error",
        message: `Updatecontrole mislukt: ${(error as Error).message}`
      });
    }
    return this.getState();
  }

  async download(): Promise<UpdateState> {
    if (!app.isPackaged) return this.getState();
    if (this.state.status !== "available" && this.state.status !== "error") return this.getState();
    this.patch({ status: "downloading", percent: 0, message: "Update downloaden…" });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.patch({
        status: "error",
        message: `Download mislukt: ${(error as Error).message}`
      });
    }
    return this.getState();
  }

  install(): void {
    if (!app.isPackaged || this.state.status !== "downloaded") return;
    autoUpdater.quitAndInstall(false, true);
  }

  private patch(partial: Partial<UpdateState>): void {
    this.state = { ...this.state, ...partial, currentVersion: app.getVersion() };
    this.listener?.(this.getState());
  }
}
