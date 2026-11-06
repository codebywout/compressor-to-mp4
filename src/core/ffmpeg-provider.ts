import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { parseEncoderSupport } from "./app-storage";
import { EMPTY_HARDWARE, HardwareCapabilities, parseHardwareListed } from "./encoders";

const RELEASE_VERSION = "9.0.2";
const DOWNLOAD_URL = `https://github.com/GyanD/codexffmpeg/releases/download/${RELEASE_VERSION}/ffmpeg-${RELEASE_VERSION}-full_build-shared.zip`;
const DOWNLOAD_SHA256 = "8d31e162f1616e37aab3fa2db991b97e1b8dbeb1c8465fd81a81be16ff91b328";
const MIN_MAJOR = 4;

export function validateArchiveListing(listing: string): void {
  for (const entry of listing.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const cleaned = normalize(entry.replaceAll("\\", "/"));
    if (cleaned.startsWith("/") || cleaned.startsWith("..") || relative(".", resolve(".", cleaned)).startsWith("..")) {
      throw new Error("Onveilig FFmpeg-archief: path traversal gedetecteerd.");
    }
  }
}

export interface FfmpegStatus {
  state: "checking" | "available" | "missing" | "invalid" | "error";
  available: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  version: string | null;
  location: string | null;
  codecs: { h264: boolean; h265: boolean; aac: boolean };
  /** Encoders that were listed AND successfully probed on this machine. */
  hardware: HardwareCapabilities;
  message: string;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  errorCode?: string;
}

function log(message: string): void {
  console.log(`[FFmpeg] ${new Date().toISOString()} ${message}`);
}

interface PersistedConfig { binDirectory: string; }

export class FfmpegProvider {
  private status: FfmpegStatus = { ...this.emptyStatus("FFmpeg wordt gecontroleerd..."), state: "checking" };
  private configPath: string;

  constructor(
    private readonly bundledDirectory = join(process.resourcesPath, "ffmpeg"),
    private readonly userDataDirectory = process.cwd(),
    private readonly wingetPackagesDirectory = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages")
  ) {
    this.configPath = join(userDataDirectory, "ffmpeg.json");
  }

  getStatus(): FfmpegStatus { return this.status; }
  getFfmpegPath(): string { return this.status.location ? join(this.status.location, "ffmpeg.exe") : "ffmpeg"; }
  getFfprobePath(): string { return this.status.location ? join(this.status.location, "ffprobe.exe") : "ffprobe"; }

  async detect(): Promise<FfmpegStatus> {
    log("Starting detection");
    this.status = { ...this.emptyStatus("FFmpeg wordt gecontroleerd..."), state: "checking" };
    const candidates = this.findLocalCandidates();
    for (const directory of candidates) {
      log(`Checking location: ${directory}`);
      const result = await this.validate(directory);
      this.status = result;
      if (result.available) {
        log("Validation finished: available");
        return result;
      }
    }
    const pathDirectory = await this.findPathDirectory();
    if (pathDirectory && !candidates.includes(resolve(pathDirectory))) {
      log(`Checking location: ${pathDirectory}`);
      const result = await this.validate(pathDirectory);
      this.status = result;
      if (result.available) {
        log("Validation finished: available");
        return result;
      }
    }
    const wingetDirectory = await this.findWingetDirectory();
    if (wingetDirectory && !candidates.includes(resolve(wingetDirectory)) && resolve(wingetDirectory) !== resolve(pathDirectory ?? "")) {
      log(`Checking WinGet location: ${wingetDirectory}`);
      const result = await this.validate(wingetDirectory);
      this.status = result;
      if (result.available) {
        await this.persistDirectory(wingetDirectory);
        log("Validation finished: available");
        return result;
      }
    }
    if (!candidates.length && !pathDirectory && !wingetDirectory) {
      const result = this.emptyStatus("FFmpeg en FFprobe zijn niet gevonden in de app-map, WinGet of Windows PATH.");
      this.status = { ...result, state: "missing" };
      log(`Validation finished: ${this.status.state}`);
      return this.status;
    }
    const result = this.status;
    log(`Validation finished: ${result.state}`);
    return result;
  }

  private findLocalCandidates(): string[] {
    const candidates: string[] = [];
    const add = (directory: string | null | undefined): void => {
      if (!directory || !existsSync(join(directory, this.executableName("ffmpeg"))) || !existsSync(join(directory, this.executableName("ffprobe")))) return;
      const normalized = resolve(directory);
      if (!candidates.includes(normalized)) candidates.push(normalized);
    };
    if (!this.isElectronResourceDirectory(this.bundledDirectory)) add(this.bundledDirectory);
    add(this.readConfig()?.binDirectory);
    log(`Candidate locations: ${candidates.join(", ")}`);
    return candidates;
  }

  private async findPathDirectory(): Promise<string | null> {
    const whereCommand = process.platform === "win32" ? "where.exe" : "which";
    const ffmpeg = await this.runCommand(whereCommand, ["ffmpeg.exe"], 10_000);
    const ffprobe = await this.runCommand(whereCommand, ["ffprobe.exe"], 10_000);
    const ffmpegPaths = this.commandPaths(ffmpeg.stdout);
    const ffprobePaths = new Set(this.commandPaths(ffprobe.stdout).map((value) => resolve(dirname(value))));
    const match = ffmpegPaths.find((value) => ffprobePaths.has(resolve(dirname(value))));
    if (match) {
      const directory = dirname(match);
      log(`PATH resolved with where.exe: ${directory}`);
      return directory;
    }
    log(`PATH resolution failed: ffmpeg=${ffmpeg.error ?? ffmpeg.stderr} (code=${ffmpeg.errorCode ?? "none"}) ffprobe=${ffprobe.error ?? ffprobe.stderr} (code=${ffprobe.errorCode ?? "none"})`);
    return null;
  }

  private async findWingetDirectory(): Promise<string | null> {
    if (process.platform !== "win32") return null;
    if (!existsSync(this.wingetPackagesDirectory)) {
      log(`WinGet package directory not found: ${this.wingetPackagesDirectory}`);
      return null;
    }
    const packages = await readdir(this.wingetPackagesDirectory, { withFileTypes: true });
    for (const packageEntry of packages) {
      if (!packageEntry.isDirectory() || !/^Gyan\.FFmpeg\./i.test(packageEntry.name)) continue;
      const directory = await this.findBinDirectory(join(this.wingetPackagesDirectory, packageEntry.name)).catch(() => null);
      if (directory) {
        log(`WinGet location found: ${directory}`);
        return directory;
      }
    }
    log(`No valid FFmpeg installation found in WinGet: ${this.wingetPackagesDirectory}`);
    return null;
  }

  private commandPaths(output: string): string[] {
    return output.split(/\r?\n/).map((value) => value.trim()).filter((value) => value.length > 0);
  }

  private executableName(name: "ffmpeg" | "ffprobe"): string {
    return process.platform === "win32" ? `${name}.exe` : name;
  }

  private isElectronResourceDirectory(directory: string): boolean {
    const normalized = directory.replaceAll("\\", "/").toLowerCase();
    return normalized.includes("/node_modules/electron/dist/resources/") || normalized.endsWith("/electron/dist/resources/ffmpeg");
  }

  async select(binDirectory: string): Promise<FfmpegStatus> {
    const result = await this.validate(binDirectory);
    if (!result.available) throw new Error(result.message);
    await this.persistDirectory(binDirectory);
    this.status = result;
    return result;
  }

  private async persistDirectory(binDirectory: string): Promise<void> {
    mkdirSync(this.userDataDirectory, { recursive: true });
    writeFileSync(this.configPath, JSON.stringify({ binDirectory }, null, 2), "utf8");
  }

  async install(onProgress: (percent: number) => void): Promise<FfmpegStatus> {
    const target = join(this.userDataDirectory, "ffmpeg");
    const temporary = join(tmpdir(), `video-compressor-ffmpeg-${Date.now()}`);
    const archive = join(temporary, "ffmpeg.zip");
    mkdirSync(temporary, { recursive: true });
    try {
      onProgress(0);
      const response = await fetch(DOWNLOAD_URL, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error(`Download mislukt (HTTP ${response.status}).`);
      const total = Number(response.headers.get("content-length") ?? 0);
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.from(chunk);
        chunks.push(buffer);
        received += buffer.length;
        if (total) onProgress(Math.round(received / total * 70));
      }
      const archiveData = Buffer.concat(chunks);
      const hash = createHash("sha256").update(archiveData).digest("hex");
      if (hash !== DOWNLOAD_SHA256) throw new Error("Checksumcontrole van de FFmpeg-download is mislukt.");
      writeFileSync(archive, archiveData);
      const listing = await this.runCommand("tar", ["-tf", archive], 30_000);
      if (!listing.ok) throw new Error(`Archiefcontrole mislukt: ${listing.stderr || listing.error || "onbekende fout"}`);
      validateArchiveListing(listing.stdout);
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      const extraction = await this.runCommand("tar", ["-xf", archive, "-C", target], 120_000);
      if (!extraction.ok) throw new Error(`Uitpakken mislukt: ${extraction.stderr || extraction.error || "onbekende fout"}`);
      onProgress(90);
      const binDirectory = await this.findBinDirectory(target);
      const result = await this.select(binDirectory);
      onProgress(100);
      return result;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  private async validate(directory: string): Promise<FfmpegStatus> {
    const ffmpeg = join(directory, this.executableName("ffmpeg"));
    const ffprobe = join(directory, this.executableName("ffprobe"));
    log(`Starting validation for ${directory ?? "PATH"}`);
    log("Running ffmpeg version check");
    const versionResult = await this.execute(ffmpeg, ["-version"]);
    log(`FFmpeg version check completed: ${versionResult.ok}`);
    log("Running ffprobe version check");
    const probeResult = await this.execute(ffprobe, ["-version"]);
    log(`FFprobe version check completed: ${probeResult.ok}`);
    log("Starting codec validation");
    const encoderResult = await this.execute(ffmpeg, ["-hide_banner", "-encoders"], 30_000);
    log(`Encoder listing completed: ${encoderResult.ok}`);
    try {
      const versionOutput = versionResult.output;
      const probeOutput = probeResult.output;
      const encoderOutput = encoderResult.output;
      const versionText = `${versionOutput.stdout}\n${versionOutput.stderr}`;
      const probeText = `${probeOutput.stdout}\n${probeOutput.stderr}`;
      const encoderText = `${encoderOutput.stdout}\n${encoderOutput.stderr}`;
      const version = versionText.match(/ffmpeg version\s+([^\s]+)/)?.[1] ?? null;
      const major = version ? Number(version.split(".")[0]) : 0;

      if (!versionResult.ok && !probeResult.ok) {
        return {
          ...this.emptyStatus(directory ? "De geselecteerde FFmpeg-installatie is ongeldig." : "FFmpeg en FFprobe zijn niet gevonden."),
          state: "missing",
          location: directory ?? null
        };
      }
      if (!versionResult.ok) {
        return { ...this.emptyStatus("ffmpeg.exe kon niet worden uitgevoerd."), state: "invalid", ffprobe: probeResult.ok, location: directory ?? null };
      }
      if (!probeResult.ok) {
        return { ...this.emptyStatus("ffprobe.exe kon niet worden uitgevoerd."), state: "invalid", ffmpeg: true, version, location: directory ?? null };
      }
      if (!encoderResult.ok) {
        return {
          ...this.emptyStatus("Encoderlijst kon niet worden opgevraagd. Controleer of ffmpeg.exe correct werkt."),
          state: "invalid",
          ffmpeg: true,
          ffprobe: true,
          version,
          location: directory ?? null
        };
      }

      const codecs = parseEncoderSupport(encoderText);
      const listed = parseHardwareListed(encoderText);
      const available = Boolean(version && major >= MIN_MAJOR && probeText.includes("ffprobe") && codecs.h264 && codecs.aac);
      const hardware = available
        ? await this.probeHardware(ffmpeg, listed)
        : { ...EMPTY_HARDWARE };
      let message: string;
      if (available) {
        const hwBits = [
          hardware.nvidia.h264 || hardware.nvidia.h265 ? "NVIDIA" : null,
          hardware.amd.h264 || hardware.amd.h265 ? "AMD" : null,
          hardware.intel.h264 || hardware.intel.h265 ? "Intel" : null
        ].filter(Boolean);
        const hwNote = hwBits.length ? ` Hardware: ${hwBits.join(", ")}.` : " Geen bruikbare hardware-encoder gevonden; CPU wordt gebruikt.";
        message = (codecs.h265
          ? "FFmpeg en FFprobe zijn gereed."
          : "FFmpeg en FFprobe zijn gereed. H.265 (libx265) ontbreekt; alleen H.264 is beschikbaar.") + hwNote;
      } else if (!codecs.h264 || !codecs.aac) {
        message = "FFmpeg mist een vereiste encoder (libx264 en/of AAC).";
      } else {
        message = "FFmpeg mist een vereiste versie of codec.";
      }
      return { state: available ? "available" : "invalid", available, ffmpeg: true, ffprobe: true, version, location: directory ?? null, codecs, hardware, message };
    } catch {
      const ffmpegOk = versionResult.ok;
      const ffprobeOk = probeResult.ok;
      const message = !ffmpegOk && !ffprobeOk ? (directory ? "De geselecteerde FFmpeg-installatie is ongeldig." : "FFmpeg en FFprobe zijn niet gevonden.") : !ffmpegOk ? "ffmpeg.exe kon niet worden uitgevoerd." : "ffprobe.exe kon niet worden uitgevoerd.";
      return { ...this.emptyStatus(message), state: ffmpegOk || ffprobeOk ? "invalid" : "missing", ffmpeg: ffmpegOk, ffprobe: ffprobeOk, location: directory ?? null };
    }
  }

  /** Probe listed HW encoders with a 1-frame encode; listing alone is not enough. */
  private async probeHardware(ffmpegPath: string, listed: HardwareCapabilities): Promise<HardwareCapabilities> {
    const result: HardwareCapabilities = {
      nvidia: { h264: false, h265: false },
      intel: { h264: false, h265: false },
      amd: { h264: false, h265: false }
    };
    const probes: Array<{ family: keyof HardwareCapabilities; codec: "h264" | "h265"; encoder: string }> = [
      { family: "nvidia", codec: "h264", encoder: "h264_nvenc" },
      { family: "nvidia", codec: "h265", encoder: "hevc_nvenc" },
      { family: "amd", codec: "h264", encoder: "h264_amf" },
      { family: "amd", codec: "h265", encoder: "hevc_amf" },
      { family: "intel", codec: "h264", encoder: "h264_qsv" },
      { family: "intel", codec: "h265", encoder: "hevc_qsv" }
    ];
    for (const probe of probes) {
      if (!listed[probe.family][probe.codec]) continue;
      log(`Probing hardware encoder: ${probe.encoder}`);
      const nullTarget = process.platform === "win32" ? "NUL" : "/dev/null";
      const check = await this.runCommand(ffmpegPath, [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=size=128x72:rate=1",
        "-frames:v", "1",
        "-pix_fmt", "yuv420p",
        "-c:v", probe.encoder,
        "-f", "null", nullTarget
      ], 20_000);
      result[probe.family][probe.codec] = check.ok;
      log(`Probe ${probe.encoder}: ${check.ok ? "usable" : "unavailable"}`);
    }
    return result;
  }

  private async execute(command: string, args: string[], timeoutMs = 15_000): Promise<{ ok: boolean; output: { stdout: string; stderr: string } }> {
    const result = await this.runCommand(command, args, timeoutMs);
    return { ok: result.ok, output: { stdout: result.stdout, stderr: result.stderr } };
  }

  private runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
    return new Promise((resolve) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      log(`Starting process: ${command} ${args.join(" ")}`);
      const child = spawn(command, args, { windowsHide: true, shell: false });
      const timer = setTimeout(() => {
        log(`Process timeout, terminating: ${command}`);
        child.kill();
        finish({ ok: false, stdout, stderr, error: `Timeout na ${timeoutMs} ms`, errorCode: "ETIMEDOUT" });
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 256_000) stdout = stdout.slice(-256_000); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 32_000) stderr = stderr.slice(-32_000); });
      child.once("error", (error: NodeJS.ErrnoException) => {
        log(`Process error: ${command}, message=${error.message}, code=${error.code ?? "unknown"}`);
        finish({ ok: false, stdout, stderr, error: error.message, errorCode: error.code });
      });
      child.once("close", (code) => {
        log(`Process closed: ${command}, code=${code}`);
        if (code === -4058) log(`Executable not found: ${command}, message=The system cannot find the file specified, code=ENOENT`);
        finish({ ok: code === 0, stdout, stderr, error: code === 0 ? undefined : `Exitcode ${code}` });
      });
    });
  }

  private async findBinDirectory(root: string): Promise<string> {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(root, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.findBinDirectory(full).catch(() => null);
        if (nested) return nested;
      } else if (entry.name.toLowerCase() === "ffmpeg.exe" && existsSync(join(root, "ffprobe.exe"))) {
        return root;
      }
    }
    throw new Error("Het uitgepakte archief bevat geen ffmpeg.exe en ffprobe.exe.");
  }

  private readConfig(): PersistedConfig | null {
    try {
      const config = JSON.parse(readFileSync(this.configPath, "utf8")) as PersistedConfig;
      return typeof config.binDirectory === "string" ? config : null;
    } catch { return null; }
  }

  private emptyStatus(message: string): FfmpegStatus {
    return {
      state: "error",
      available: false,
      ffmpeg: false,
      ffprobe: false,
      version: null,
      location: null,
      codecs: { h264: false, h265: false, aac: false },
      hardware: { ...EMPTY_HARDWARE },
      message
    };
  }
}
