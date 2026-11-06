export type EncoderPreference = "auto" | "cpu" | "nvidia" | "intel" | "amd";
export type SpeedPreset = "ultrafast" | "veryfast" | "faster" | "fast" | "medium" | "slow";

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
  preset: SpeedPreset;
  keepAudio: boolean;
  /** Hardware preference; defaults to auto when omitted (older clients). */
  encoderPreference?: EncoderPreference;
}

export interface CompressionProgress {
  status: "analyzing" | "encoding" | "completed" | "cancelled" | "error";
  percent: number;
  speed: string;
  etaSeconds: number | null;
  bitrate: string;
  message?: string;
  /** Encoder that is actively encoding (after resolution / fallback). */
  encoderLabel?: string;
}

export interface EncodingPerformance {
  encoderId: string;
  encoderLabel: string;
  preset: string;
  preference: EncoderPreference;
  fellBackToCpu: boolean;
  attempts: number;
  encodingMs: number;
  moveMs: number;
  totalMs: number;
  averageFps: number | null;
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
  performance?: EncodingPerformance;
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

export interface BatchRuntimeInfo {
  concurrency: number;
  concurrencyMode: "auto" | "manual";
  encoderFamily: "cpu" | "nvidia" | "intel" | "amd";
  encoderLabel: string;
}

export interface BatchSummary {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  runtime?: BatchRuntimeInfo;
}

export interface BatchUpdate {
  item: BatchItem;
  summary: BatchSummary;
}
