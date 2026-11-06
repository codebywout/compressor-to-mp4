import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface CleanupStaleWorkDirsOptions {
  /** Directories older than this age are removed. Default: 2 hours. */
  maxAgeMs?: number;
  /** Root temp directory. Defaults to os.tmpdir(). */
  root?: string;
  /** Prefix used by Compressor work directories. */
  prefix?: string;
}

export interface CleanupStaleWorkDirsResult {
  scanned: number;
  removed: string[];
  failed: Array<{ path: string; error: string }>;
}

/**
 * Removes orphaned `vc-work-*` directories left behind after a crash or force-kill.
 * Safe to call at application startup; never throws.
 */
export function cleanupStaleWorkDirs(options: CleanupStaleWorkDirsOptions = {}): CleanupStaleWorkDirsResult {
  const maxAgeMs = options.maxAgeMs ?? 2 * 60 * 60 * 1000;
  const root = options.root ?? tmpdir();
  const prefix = options.prefix ?? "vc-work-";
  const result: CleanupStaleWorkDirsResult = { scanned: 0, removed: [], failed: [] };

  if (!existsSync(root)) return result;

  let entries: string[] = [];
  try {
    entries = readdirSync(root).filter((name) => name.startsWith(prefix));
  } catch {
    return result;
  }

  const now = Date.now();
  for (const name of entries) {
    const path = join(root, name);
    result.scanned += 1;
    try {
      const stats = statSync(path);
      if (!stats.isDirectory()) continue;
      const ageMs = now - stats.mtimeMs;
      if (ageMs < maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
      result.removed.push(path);
    } catch (error) {
      result.failed.push({
        path,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return result;
}
