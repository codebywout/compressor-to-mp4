import { contextBridge, ipcRenderer } from "electron";
import { BatchItem, BatchUpdate, VideoMetadata } from "./shared/types";
import type { FfmpegStatus } from "./core/ffmpeg-provider";
import type { UpdateState } from "./core/updater";

contextBridge.exposeInMainWorld("videoCompressor", {
  getAppInfo: (): Promise<{ name: string; version: string; packaged: boolean; userData: string; appDirectory: string }> => ipcRenderer.invoke("app-info"),
  getUpdateStatus: (): Promise<UpdateState> => ipcRenderer.invoke("update-status"),
  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke("update-check"),
  downloadUpdate: (): Promise<UpdateState> => ipcRenderer.invoke("update-download"),
  installUpdate: (): Promise<boolean> => ipcRenderer.invoke("update-install"),
  selectFiles: (): Promise<string[]> => ipcRenderer.invoke("select-files"),
  probe: (filePath: string): Promise<VideoMetadata> => ipcRenderer.invoke("probe", filePath),
  ffmpegStatus: (): Promise<FfmpegStatus> => ipcRenderer.invoke("ffmpeg-status"),
  recheckFfmpeg: (): Promise<FfmpegStatus> => ipcRenderer.invoke("recheck-ffmpeg"),
  selectFfmpeg: (): Promise<FfmpegStatus> => ipcRenderer.invoke("select-ffmpeg"),
  installFfmpeg: (): Promise<FfmpegStatus> => ipcRenderer.invoke("install-ffmpeg"),
  startBatch: (items: BatchItem[], concurrency: number): Promise<void> => ipcRenderer.invoke("start-batch", items, concurrency),
  cancelBatch: (): void => { ipcRenderer.send("cancel-batch"); },
  cancelItem: (id: string): void => { ipcRenderer.send("cancel-item", id); },
  openFile: (filePath: string): Promise<string> => ipcRenderer.invoke("open-file", filePath),
  showInFolder: (filePath: string): Promise<void> => ipcRenderer.invoke("show-in-folder", filePath),
  saveCopy: (filePath: string): Promise<string | null> => ipcRenderer.invoke("save-copy", filePath),
  onBinaryStatus: (callback: (status: FfmpegStatus) => void): void => { ipcRenderer.on("binaries", (_event, status) => callback(status)); },
  onFfmpegInstallProgress: (callback: (percent: number) => void): void => { ipcRenderer.on("ffmpeg-install-progress", (_event, percent) => callback(percent)); },
  onBatchUpdate: (callback: (update: BatchUpdate) => void): void => { ipcRenderer.on("batch-update", (_event, update) => callback(update)); },
  onBinaryError: (callback: (message: string) => void): void => { ipcRenderer.on("binary-error", (_event, message) => callback(message)); },
  onUpdateStatus: (callback: (state: UpdateState) => void): void => { ipcRenderer.on("update-status", (_event, state) => callback(state)); }
});
