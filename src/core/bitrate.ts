import { CompressionSettings, VideoMetadata } from "../shared/types";

export const MB = 1_000_000;

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
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("De videoduur is ongeldig of ontbreekt.");
  }
  const totalKbps = (mbToBytes(targetMb) * 8 / durationSeconds) / 1000;
  const audioKbps = settings.keepAudio ? settings.audioBitrateKbps : 0;
  const usable = totalKbps * safetyMargin * (1 - overhead) - audioKbps;
  return Math.max(100, Math.floor(usable));
}

export function resolutionFilter(metadata: VideoMetadata, resolution: CompressionSettings["resolution"]): string | null {
  if (resolution === "original") return null;
  const height = Number(resolution.replace("p", ""));
  if (!Number.isInteger(height) || height <= 0 || metadata.height <= height) return null;
  return `scale=-2:${height}`;
}
