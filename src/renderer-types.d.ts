import type { BatchItem, BatchUpdate, VideoMetadata } from "./shared/types";
import type { FfmpegStatus } from "./core/ffmpeg-provider";
import type { UpdateState } from "./core/updater";

export {};

declare global {
  interface Window {
    videoCompressor: {
      getAppInfo(): Promise<{ name: string; version: string; packaged: boolean; userData: string; appDirectory: string }>;
      getUpdateStatus(): Promise<UpdateState>;
      checkForUpdates(): Promise<UpdateState>;
      downloadUpdate(): Promise<UpdateState>;
      installUpdate(): Promise<boolean>;
      selectFiles(): Promise<string[]>;
      probe(path: string): Promise<VideoMetadata>;
      ffmpegStatus(): Promise<FfmpegStatus>;
      recheckFfmpeg(): Promise<FfmpegStatus>;
      selectFfmpeg(): Promise<FfmpegStatus>;
      installFfmpeg(): Promise<FfmpegStatus>;
      startBatch(items: BatchItem[], concurrency: number): Promise<void>;
      cancelBatch(): void;
      cancelItem(id: string): void;
      openFile(path: string): Promise<string>;
      showInFolder(path: string): Promise<void>;
      saveCopy(path: string): Promise<string | null>;
      onBinaryStatus(callback: (status: FfmpegStatus) => void): void;
      onFfmpegInstallProgress(callback: (percent: number) => void): void;
      onBatchUpdate(callback: (update: BatchUpdate) => void): void;
      onBinaryError(callback: (message: string) => void): void;
      onUpdateStatus(callback: (state: UpdateState) => void): void;
    };
  }
}
