export type ThemePreference = "system" | "light" | "dark";

export interface StoredPreferences {
  mode?: "compress" | "convert";
  targetMb?: number;
  concurrency?: number;
  audioBitrate?: string;
  videoCodec?: string;
  encoderPreference?: string;
  preset?: string;
  resolution?: string;
  frameRate?: string;
  keepAudio?: boolean;
  advanced?: boolean;
  theme?: ThemePreference;
}

export interface StoredHistoryEntry {
  id: string;
  inputPath: string;
  outputPath: string | null;
  finishedAt: string;
  originalBytes: number;
  outputBytes: number | null;
  status: "completed" | "failed" | "cancelled";
  error?: string;
  durationSeconds: number | null;
}

const AUDIO = new Set(["48", "64", "96", "128", "160", "192"]);
const CODECS = new Set(["h264", "h265"]);
const ENCODERS = new Set(["auto", "cpu", "nvidia", "intel", "amd"]);
const PRESETS = new Set(["ultrafast", "veryfast", "faster", "fast", "medium", "slow"]);
const RESOLUTIONS = new Set(["original", "1080p", "720p", "480p"]);
const FRAMERATES = new Set(["original", "24", "25", "30", "60"]);

export function parsePreferencesJson(raw: string | null): StoredPreferences | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as StoredPreferences;
    if (!value || typeof value !== "object") return null;
    const preferences: StoredPreferences = {};
    if (value.mode === "compress" || value.mode === "convert") preferences.mode = value.mode;
    if (typeof value.targetMb === "number" && Number.isFinite(value.targetMb) && value.targetMb > 0) {
      preferences.targetMb = value.targetMb;
    }
    if (typeof value.concurrency === "number" && Number.isInteger(value.concurrency)) {
      preferences.concurrency = Math.min(8, Math.max(0, value.concurrency));
    }
    if (typeof value.audioBitrate === "string" && AUDIO.has(value.audioBitrate)) preferences.audioBitrate = value.audioBitrate;
    if (typeof value.videoCodec === "string" && CODECS.has(value.videoCodec)) preferences.videoCodec = value.videoCodec;
    if (typeof value.encoderPreference === "string" && ENCODERS.has(value.encoderPreference)) {
      preferences.encoderPreference = value.encoderPreference;
    }
    if (typeof value.preset === "string" && PRESETS.has(value.preset)) preferences.preset = value.preset;
    if (typeof value.resolution === "string" && RESOLUTIONS.has(value.resolution)) preferences.resolution = value.resolution;
    if (typeof value.frameRate === "string" && FRAMERATES.has(value.frameRate)) preferences.frameRate = value.frameRate;
    if (typeof value.keepAudio === "boolean") preferences.keepAudio = value.keepAudio;
    if (typeof value.advanced === "boolean") preferences.advanced = value.advanced;
    if (value.theme === "system" || value.theme === "light" || value.theme === "dark") preferences.theme = value.theme;
    return preferences;
  } catch {
    return null;
  }
}

export function parseHistoryJson(raw: string | null): StoredHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const entries: StoredHistoryEntry[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Partial<StoredHistoryEntry>;
      if (typeof candidate.id !== "string" || typeof candidate.inputPath !== "string") continue;
      if (typeof candidate.finishedAt !== "string") continue;
      if (candidate.status !== "completed" && candidate.status !== "failed" && candidate.status !== "cancelled") continue;
      if (typeof candidate.originalBytes !== "number" || !Number.isFinite(candidate.originalBytes)) continue;
      entries.push({
        id: candidate.id,
        inputPath: candidate.inputPath,
        outputPath: typeof candidate.outputPath === "string" ? candidate.outputPath : null,
        finishedAt: candidate.finishedAt,
        originalBytes: candidate.originalBytes,
        outputBytes: typeof candidate.outputBytes === "number" && Number.isFinite(candidate.outputBytes) ? candidate.outputBytes : null,
        status: candidate.status,
        error: typeof candidate.error === "string" ? candidate.error : undefined,
        durationSeconds: typeof candidate.durationSeconds === "number" && Number.isFinite(candidate.durationSeconds)
          ? candidate.durationSeconds
          : null
      });
      if (entries.length >= 200) break;
    }
    return entries;
  } catch {
    return [];
  }
}

export function parseEncoderSupport(encoderText: string): { h264: boolean; h265: boolean; aac: boolean } {
  return {
    h264: /\blibx264\b/.test(encoderText),
    h265: /\blibx265\b/.test(encoderText),
    aac: /\baac\b/.test(encoderText)
  };
}
