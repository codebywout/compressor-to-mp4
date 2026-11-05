import { BrowserWindow, app, dialog } from "electron";
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

function friendlyUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/Cannot find latest\.yml|latest\.yml.*404|HttpError:\s*404/i.test(message)) {
    return "Updatecontrole mislukt: de nieuwste GitHub Release mist installer-bestanden (latest.yml). Publiceer opnieuw via de release-workflow.";
  }
  if (!message) return "Updatecontrole mislukt.";
  const short = message.split("\n")[0]?.trim() || message;
  return short.length > 220 ? `${short.slice(0, 217)}…` : short;
}

export class AppUpdater {
  private state: UpdateState;
  private listener: UpdateListener | null = null;
  private window: BrowserWindow | null = null;
  private started = false;
  private prompting = false;
  private skippedVersion: string | null = null;
  private checkTimer: NodeJS.Timeout | null = null;

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
      void this.askToUpdate(info);
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
      void this.askToInstall(info.version);
    });
    autoUpdater.on("error", (error) => {
      this.patch({
        status: "error",
        message: friendlyUpdateError(error),
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
    this.window = window;
    const schedule = () => {
      setTimeout(() => { void this.check().catch(() => undefined); }, 3_000);
      this.checkTimer = setInterval(() => {
        void this.check().catch(() => undefined);
      }, 6 * 60 * 60 * 1000);
    };
    if (window.webContents.isLoading()) {
      window.webContents.once("did-finish-load", schedule);
    } else {
      schedule();
    }
    window.on("closed", () => {
      this.window = null;
      if (this.checkTimer) clearInterval(this.checkTimer);
    });
  }

  async check(): Promise<UpdateState> {
    if (!app.isPackaged) return this.getState();
    if (this.state.status === "downloading" || this.state.status === "downloaded" || this.prompting) {
      return this.getState();
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.patch({
        status: "error",
        message: friendlyUpdateError(error)
      });
    }
    return this.getState();
  }

  async download(): Promise<UpdateState> {
    if (!app.isPackaged) return this.getState();
    if (this.state.status !== "available" && this.state.status !== "error") return this.getState();
    this.skippedVersion = null;
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

  private async askToUpdate(info: UpdateInfo): Promise<void> {
    if (!this.window || this.window.isDestroyed() || this.prompting) return;
    if (this.skippedVersion === info.version) return;
    if (this.state.status === "downloading" || this.state.status === "downloaded") return;

    this.prompting = true;
    try {
      const notes = notesToText(info.releaseNotes);
      const result = await dialog.showMessageBox(this.window, {
        type: "info",
        title: "Update beschikbaar",
        message: `Versie ${info.version} is beschikbaar`,
        detail: [
          `Je gebruikt nu versie ${app.getVersion()}.`,
          "Wil je de update downloaden en installeren?",
          notes ? `\nWat is nieuw:\n${notes.slice(0, 800)}` : ""
        ].filter(Boolean).join("\n"),
        buttons: ["Later", "Nu updaten"],
        defaultId: 1,
        cancelId: 0,
        noLink: true
      });
      if (result.response === 1) {
        await this.download();
      } else {
        this.skippedVersion = info.version;
        this.patch({
          status: "available",
          availableVersion: info.version,
          message: `Versie ${info.version} is beschikbaar. Klik op het versienummer om later te updaten.`
        });
      }
    } finally {
      this.prompting = false;
    }
  }

  private async askToInstall(version: string): Promise<void> {
    if (!this.window || this.window.isDestroyed() || this.prompting) return;
    this.prompting = true;
    try {
      const result = await dialog.showMessageBox(this.window, {
        type: "info",
        title: "Update klaar",
        message: `Versie ${version} is gedownload`,
        detail: "De app moet herstarten om de update te installeren. Doorgaan?",
        buttons: ["Later", "Herstart en installeer"],
        defaultId: 1,
        cancelId: 0,
        noLink: true
      });
      if (result.response === 1) this.install();
    } finally {
      this.prompting = false;
    }
  }

  private patch(partial: Partial<UpdateState>): void {
    this.state = { ...this.state, ...partial, currentVersion: app.getVersion() };
    this.listener?.(this.getState());
  }
}
