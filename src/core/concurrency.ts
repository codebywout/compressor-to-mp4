import { EncoderFamily } from "./encoders";
import { SystemResources } from "./system-resources";

export interface AdaptiveConcurrencyInput {
  family: EncoderFamily;
  /** Largest frame area in the batch (width * height). */
  maxPixels: number;
  resources: Pick<SystemResources, "logicalCpus" | "freeMemoryBytes" | "totalMemoryBytes" | "nvidia">;
  /** Hard ceiling (UI max). */
  maxConcurrency?: number;
}

/**
 * Stable, conservative concurrency for a whole batch (computed once at start).
 * Values are intentionally not aggressive: more jobs ≠ higher throughput.
 */
export function computeAdaptiveConcurrency(input: AdaptiveConcurrencyInput): number {
  const maxCap = clampInt(input.maxConcurrency ?? 8, 1, 8);
  const cpus = clampInt(input.resources.logicalCpus, 1, 256);
  const freeGb = input.resources.freeMemoryBytes / 1_000_000_000;
  const isUhd = input.maxPixels >= 3_500_000; // ~2560x1440+
  const is4k = input.maxPixels >= 7_000_000; // ~3840x2160

  let value: number;
  if (input.family === "cpu") {
    value = Math.max(1, Math.min(4, Math.floor(cpus / 4) || 1));
    if (is4k) value = Math.min(value, 2);
    else if (isUhd) value = Math.min(value, 3);
  } else if (input.family === "nvidia") {
    // Measured on RTX 4060 (4×1080p30): c2 captures most throughput; c3/c4 add little.
    value = is4k ? 2 : 2;
    const nvidia = input.resources.nvidia;
    if (nvidia) {
      if (nvidia.memoryFreeMiB < 1500) value = 1;
      else if (nvidia.memoryFreeMiB < 3000) value = Math.min(value, 2);
      if (nvidia.utilizationEncoder != null && nvidia.utilizationEncoder >= 85) value = Math.min(value, 1);
      else if (nvidia.utilizationEncoder != null && nvidia.utilizationEncoder >= 60) value = Math.min(value, 2);
    }
  } else if (input.family === "amd") {
    // Measured: AMF c2 >> c1 on short 1080p batches; keep 4K serial-ish.
    value = is4k ? 1 : 2;
  } else {
    // intel qsv
    value = is4k ? 1 : 2;
  }

  // System RAM guard: leave headroom for OS + Electron UI.
  if (freeGb < 1.5) value = 1;
  else if (freeGb < 3) value = Math.min(value, 2);
  else if (freeGb < 5) value = Math.min(value, 3);

  return clampInt(value, 1, maxCap);
}

export function maxPixelsInBatch(items: Array<{ metadata: { width: number; height: number }; settings: { resolution: string } }>): number {
  let max = 0;
  for (const item of items) {
    max = Math.max(max, effectivePixels(item.metadata.width, item.metadata.height, item.settings.resolution));
  }
  return max || 1280 * 720;
}

export function effectivePixels(width: number, height: number, resolution: string): number {
  const w = Number.isFinite(width) && width > 0 ? width : 1280;
  const h = Number.isFinite(height) && height > 0 ? height : 720;
  if (resolution === "original") return w * h;
  const targetHeight = Number(String(resolution).replace("p", ""));
  if (!Number.isFinite(targetHeight) || targetHeight <= 0 || h <= targetHeight) return w * h;
  const scale = targetHeight / h;
  return Math.round(w * scale) * targetHeight;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
