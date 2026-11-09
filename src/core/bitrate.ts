import { CompressionSettings, VideoMetadata } from "../shared/types";

export const MB = 1_000_000;
/** Absolute floor — below this, encoders often ignore the target or produce unstable output. */
export const MIN_VIDEO_BITRATE_KBPS = 48;
/** Preferred floor when the size budget still has room. */
export const PREFERRED_VIDEO_BITRATE_KBPS = 100;
const AUDIO_FALLBACK_STEPS_KBPS = [96, 64, 48, 32];

export interface SizeBudget {
  videoBitrateKbps: number;
  audioBitrateKbps: number;
  keepAudio: boolean;
  /** True when audio was lowered automatically to fit the target. */
  audioReduced: boolean;
  totalKbps: number;
}

export function mbToBytes(mb: number): number {
  if (!Number.isFinite(mb) || mb <= 0) {
    throw new Error("Doelgrootte moet groter zijn dan 0 MB.");
  }
  return Math.floor(mb * MB);
}

export function calculateVideoBitrateKbps(
  targetMb: number,
  durationSeconds: number,
  settings: Pick<CompressionSettings, "audioBitrateKbps" | "keepAudio">,
  safetyMargin = 0.96,
  overhead = 0.02,
): number {
  return planSizeBudget(targetMb, durationSeconds, settings, safetyMargin, overhead).videoBitrateKbps;
}

/**
 * Plans video + audio bitrates so long videos can still hit a tight MB limit.
 * When audio would leave too little for video, audio is stepped down automatically.
 */
export function planSizeBudget(
  targetMb: number,
  durationSeconds: number,
  settings: Pick<CompressionSettings, "audioBitrateKbps" | "keepAudio">,
  safetyMargin = 0.96,
  overhead = 0.02,
): SizeBudget {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("De videoduur is ongeldig of ontbreekt.");
  }
  const totalKbps = (mbToBytes(targetMb) * 8 / durationSeconds) / 1000;
  const budgetKbps = totalKbps * safetyMargin * (1 - overhead);
  let keepAudio = Boolean(settings.keepAudio);
  let audioKbps = keepAudio ? Math.max(0, Math.floor(settings.audioBitrateKbps)) : 0;
  let audioReduced = false;

  const videoFor = (audio: number): number => Math.floor(budgetKbps - audio);

  if (keepAudio && videoFor(audioKbps) < PREFERRED_VIDEO_BITRATE_KBPS) {
    for (const step of AUDIO_FALLBACK_STEPS_KBPS) {
      if (step >= audioKbps) continue;
      audioKbps = step;
      audioReduced = true;
      if (videoFor(audioKbps) >= PREFERRED_VIDEO_BITRATE_KBPS) break;
    }
  }

  let videoKbps = videoFor(audioKbps);
  if (keepAudio && videoKbps < MIN_VIDEO_BITRATE_KBPS) {
    // Last resort: drop to the lowest speech-friendly AAC rate.
    if (audioKbps > 32) {
      audioKbps = 32;
      audioReduced = true;
      videoKbps = videoFor(audioKbps);
    }
  }

  if (keepAudio && videoKbps < MIN_VIDEO_BITRATE_KBPS && audioKbps > 0) {
    // Still impossible with audio — leave audio on but use the absolute video floor;
    // retries / user may still need a higher target.
    videoKbps = MIN_VIDEO_BITRATE_KBPS;
  }

  if (!keepAudio) {
    videoKbps = Math.floor(budgetKbps);
  }

  return {
    videoBitrateKbps: Math.max(MIN_VIDEO_BITRATE_KBPS, Math.floor(videoKbps)),
    audioBitrateKbps: keepAudio ? audioKbps : 0,
    keepAudio,
    audioReduced,
    totalKbps
  };
}

export function resolutionFilter(metadata: VideoMetadata, resolution: CompressionSettings["resolution"]): string | null {
  if (resolution === "original") return null;
  const height = Number(resolution.replace("p", ""));
  if (!Number.isInteger(height) || height <= 0 || metadata.height <= height) return null;
  return `scale=-2:${height}`;
}
