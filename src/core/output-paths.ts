import { existsSync } from "node:fs";
import { join, parse, resolve } from "node:path";

/**
 * Reserves unique MP4 output paths for concurrent jobs.
 * On Windows, reservation keys are case-insensitive.
 */
export class OutputPathAllocator {
  private readonly reserved = new Set<string>();

  key(filePath: string): string {
    return resolve(filePath).replaceAll("/", "\\").toLowerCase();
  }

  isReserved(filePath: string): boolean {
    return this.reserved.has(this.key(filePath));
  }

  release(filePath: string): void {
    this.reserved.delete(this.key(filePath));
  }

  clear(): void {
    this.reserved.clear();
  }

  /**
   * Reserve a unique sibling MP4 path for an input file.
   * Skips names that are reserved or already present on disk.
   */
  reserveFromInput(inputPath: string, outputDirectory?: string): string {
    const parsed = parse(inputPath);
    const directory = outputDirectory ?? parsed.dir;
    for (let index = 0; index <= 10_000; index++) {
      const fileName = index === 0 ? `${parsed.name}.mp4` : `${parsed.name} (${index}).mp4`;
      const candidate = join(directory, fileName);
      const reservationKey = this.key(candidate);
      if (this.reserved.has(reservationKey)) continue;
      if (existsSync(candidate)) continue;
      this.reserved.add(reservationKey);
      return candidate;
    }
    throw new Error(`Kon geen unieke uitvoernaam vinden in "${directory}".`);
  }

  /**
   * Re-check just before the final move. If the reserved path became occupied
   * by something else on disk, release it and reserve a new free name.
   */
  ensureStillAvailable(reservedPath: string, inputPath: string, outputDirectory?: string): string {
    const reservationKey = this.key(reservedPath);
    if (!this.reserved.has(reservationKey)) {
      return this.reserveFromInput(inputPath, outputDirectory);
    }
    if (!existsSync(reservedPath)) return reservedPath;
    this.reserved.delete(reservationKey);
    return this.reserveFromInput(inputPath, outputDirectory);
  }
}

/** Pure helper for tests: next candidate names following the app convention. */
export function candidateOutputNames(baseName: string, count: number): string[] {
  const names: string[] = [];
  for (let index = 0; index < count; index++) {
    names.push(index === 0 ? `${baseName}.mp4` : `${baseName} (${index}).mp4`);
  }
  return names;
}
