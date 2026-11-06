import { BatchItem } from "../shared/types";
import { effectivePixels } from "./concurrency";

/**
 * Relative encoding cost. Lower = prefer earlier (short / simple first),
 * so a single heavy 4K file does not block the head of a serial queue.
 * UI order is unchanged; only claim order among queued items.
 *
 * Within a closed batch every job is eventually claimed (SJF, then remaining).
 */
export function estimateJobWeight(item: Pick<BatchItem, "metadata" | "settings">): number {
  const duration = Number.isFinite(item.metadata.duration) && item.metadata.duration > 0
    ? item.metadata.duration
    : 1;
  const fps = Number.isFinite(item.metadata.frameRate) && item.metadata.frameRate > 0
    ? item.metadata.frameRate
    : 30;
  const pixels = effectivePixels(item.metadata.width, item.metadata.height, item.settings.resolution);
  const modeFactor = item.settings.mode === "convert" ? 0.15 : 1;
  const presetFactor = presetWeight(item.settings.preset);
  return duration * (pixels / 1_000_000) * (fps / 30) * modeFactor * presetFactor;
}

function presetWeight(preset: string): number {
  switch (preset) {
    case "ultrafast": return 0.55;
    case "veryfast": return 0.65;
    case "faster": return 0.75;
    case "fast": return 0.85;
    case "slow": return 1.35;
    default: return 1;
  }
}

/** Pick the lightest queued item; stable tie-break by original list index. */
export function selectNextQueuedItem<T extends Pick<BatchItem, "status" | "metadata" | "settings">>(
  items: Iterable<T>,
): T | null {
  let best: T | null = null;
  let bestWeight = Number.POSITIVE_INFINITY;
  let bestIndex = Number.POSITIVE_INFINITY;
  let index = 0;
  for (const item of items) {
    if (item.status === "queued") {
      const weight = estimateJobWeight(item);
      if (weight < bestWeight || (weight === bestWeight && index < bestIndex)) {
        best = item;
        bestWeight = weight;
        bestIndex = index;
      }
    }
    index += 1;
  }
  return best;
}
