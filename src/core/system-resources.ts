import { freemem, totalmem, cpus } from "node:os";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface NvidiaSnapshot {
  name: string;
  memoryTotalMiB: number;
  memoryFreeMiB: number;
  utilizationGpu: number | null;
  utilizationEncoder: number | null;
}

export interface SystemResources {
  logicalCpus: number;
  freeMemoryBytes: number;
  totalMemoryBytes: number;
  nvidia: NvidiaSnapshot | null;
}

/** Best-effort snapshot. Never throws; nvidia-smi is optional. */
export async function readSystemResources(timeoutMs = 2500): Promise<SystemResources> {
  return {
    logicalCpus: Math.max(1, cpus().length),
    freeMemoryBytes: freemem(),
    totalMemoryBytes: totalmem(),
    nvidia: await readNvidiaSnapshot(timeoutMs)
  };
}

export function readSystemResourcesSync(): Omit<SystemResources, "nvidia"> & { nvidia: null } {
  return {
    logicalCpus: Math.max(1, cpus().length),
    freeMemoryBytes: freemem(),
    totalMemoryBytes: totalmem(),
    nvidia: null
  };
}

async function readNvidiaSnapshot(timeoutMs: number): Promise<NvidiaSnapshot | null> {
  const executable = resolveNvidiaSmi();
  if (!executable) return null;
  try {
    const output = await runCapture(
      executable,
      ["--query-gpu=name,memory.total,memory.free,utilization.gpu,utilization.encoder", "--format=csv,noheader,nounits"],
      timeoutMs
    );
    const line = output.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    if (!line) return null;
    const parts = line.split(",").map((value) => value.trim());
    if (parts.length < 3) return null;
    const memoryTotalMiB = Number(parts[1]);
    const memoryFreeMiB = Number(parts[2]);
    const utilizationGpu = parts[3] != null && parts[3] !== "[N/A]" ? Number(parts[3]) : null;
    const utilizationEncoder = parts[4] != null && parts[4] !== "[N/A]" ? Number(parts[4]) : null;
    if (!Number.isFinite(memoryTotalMiB) || !Number.isFinite(memoryFreeMiB)) return null;
    return {
      name: parts[0] || "NVIDIA",
      memoryTotalMiB,
      memoryFreeMiB,
      utilizationGpu: Number.isFinite(utilizationGpu) ? utilizationGpu : null,
      utilizationEncoder: Number.isFinite(utilizationEncoder) ? utilizationEncoder : null
    };
  } catch {
    return null;
  }
}

function resolveNvidiaSmi(): string | null {
  const candidates = [
    "nvidia-smi",
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "nvidia-smi.exe"),
    "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe"
  ];
  for (const candidate of candidates) {
    if (candidate === "nvidia-smi") return candidate;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function runCapture(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { windowsHide: true, shell: false });
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("timeout"));
    }, timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout || stderr);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr || `exit ${code}`));
    });
  });
}
