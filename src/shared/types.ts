export interface VideoMetadata {
  size: number;
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  videoCodec: string;
  audioCodec: string | null;
  audioChannels: number | null;
  audioSampleRate: number | null;
}

export interface CompressionSettings {
  mode: "compress" | "convert";
  targetMb: number;
  videoCodec: "h264" | "h265";
  audioBitrateKbps: number;
  resolution: "original" | "1080p" | "720p" | "480p";
  frameRate: "original" | number;
  preset: "ultrafast" | "fast" | "medium" | "slow";
  keepAudio: boolean;
}

export interface CompressionProgress {
  status: "analyzing" | "encoding" | "completed" | "cancelled" | "error";
  percent: number;
  speed: string;
  etaSeconds: number | null;
  bitrate: string;
  message?: string;
}

export interface CompressionResult {
  inputPath: string;
  outputPath: string;
  originalBytes: number;
  outputBytes: number;
  duration: number;
  videoBitrateKbps: number;
  settings: CompressionSettings;
  metadata: VideoMetadata;
}

export type BatchItemStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface BatchItem {
  id: string;
  inputPath: string;
  metadata: VideoMetadata;
  settings: CompressionSettings;
  targetOverridden?: boolean;
  status: BatchItemStatus;
  progress: CompressionProgress;
  result?: CompressionResult;
  error?: string;
}

export interface BatchUpdate {
  item: BatchItem;
  summary: { queued: number; running: number; completed: number; failed: number; cancelled: number };
}
