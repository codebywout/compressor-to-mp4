import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { calculateVideoBitrateKbps, resolutionFilter } from "./bitrate";
import { OutputPathAllocator } from "./output-paths";
import { ManagedProcess } from "./process";
import { CompressionProgress, CompressionResult, CompressionSettings, VideoMetadata } from "../shared/types";

type ProgressCallback = (progress: CompressionProgress) => void;

export interface CompressOptions {
  outputDirectory?: string;
  /** Shared allocator for concurrent jobs in the same batch. */
  outputAllocator?: OutputPathAllocator;
}

export class Compressor {
  private activeProcess: ManagedProcess | null = null;
  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
    this.activeProcess?.cancel();
  }

  async compress(
    ffmpegPath: string,
    inputPath: string,
    metadata: VideoMetadata,
    settings: CompressionSettings,
    onProgress: ProgressCallback,
    options: CompressOptions = {},
  ): Promise<CompressionResult> {
    if (!existsSync(inputPath)) throw new Error("Het invoerbestand bestaat niet meer.");
    if (settings.mode === "compress" && settings.targetMb <= 0) throw new Error("Doelgrootte moet groter zijn dan 0 MB.");
    this.cancelled = false;

    const allocator = options.outputAllocator ?? new OutputPathAllocator();
    let reservedPath = allocator.reserveFromInput(inputPath, options.outputDirectory);
    const originalBytes = statSync(inputPath).size;
    const workDir = mkdtempSync(join(tmpdir(), "vc-work-"));
    const tempOutput = join(workDir, "output.mp4");

    let videoBitrateKbps = 0;
    try {
      if (settings.mode === "convert") {
        await this.convert(ffmpegPath, inputPath, tempOutput, metadata, settings, onProgress);
      } else {
        let bitrate = calculateVideoBitrateKbps(settings.targetMb, metadata.duration, settings);
        let success = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (this.cancelled) throw new Error("Conversie geannuleerd.");
          onProgress({ status: "encoding", percent: 0, speed: "", etaSeconds: null, bitrate: `${bitrate} kb/s`, message: `Poging ${attempt + 1}/3` });
          rmSync(tempOutput, { force: true });
          await this.twoPass(ffmpegPath, inputPath, tempOutput, workDir, metadata, settings, bitrate, onProgress);
          const outputBytes = statSync(tempOutput).size;
          if (outputBytes <= settings.targetMb * 1_000_000) {
            videoBitrateKbps = bitrate;
            success = true;
            break;
          }
          bitrate = Math.max(100, Math.floor(bitrate * (settings.targetMb * 1_000_000 / outputBytes) * 0.97));
        }
        if (!success) throw new Error("FFmpeg kon de ingestelde maximale bestandsgrootte niet bereiken.");
      }

      if (this.cancelled) throw new Error("Conversie geannuleerd.");
      if (!existsSync(tempOutput)) throw new Error("Het tijdelijke uitvoerbestand ontbreekt na encoding.");

      onProgress({ status: "encoding", percent: 99, speed: "", etaSeconds: null, bitrate: "", message: "MP4 wordt opgeslagen naast het bronbestand" });
      try {
        reservedPath = allocator.ensureStillAvailable(reservedPath, inputPath, options.outputDirectory);
      } catch (error) {
        throw new Error(
          `Uitvoerbestand kon niet veilig worden aangemaakt: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (existsSync(reservedPath)) {
        throw new Error(`Uitvoerbestand kon niet veilig worden aangemaakt: "${reservedPath}" bestaat al.`);
      }
      moveFile(tempOutput, reservedPath);
      if (!existsSync(reservedPath)) {
        throw new Error(`Uitvoerbestand kon niet veilig worden aangemaakt: verplaatsen naar "${reservedPath}" is mislukt.`);
      }
      const outputBytes = statSync(reservedPath).size;
      return { inputPath, outputPath: reservedPath, originalBytes, outputBytes, duration: metadata.duration, videoBitrateKbps, settings, metadata };
    } catch (error) {
      rmSync(tempOutput, { force: true });
      throw improveIoError(error, reservedPath);
    } finally {
      allocator.release(reservedPath);
      cleanupWorkDir(workDir);
      this.activeProcess = null;
    }
  }

  private async convert(
    ffmpegPath: string, inputPath: string, outputPath: string, metadata: VideoMetadata,
    settings: CompressionSettings, onProgress: ProgressCallback
  ): Promise<void> {
    try {
      onProgress({ status: "encoding", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Streams worden zonder hercodering gekopieerd" });
      await this.runEncoding(ffmpegPath, [
        "-y", "-fflags", "+genpts", "-i", inputPath,
        "-map", "0:v:0", "-map", "0:a:0?", "-dn", "-sn",
        "-c", "copy", "-movflags", "+faststart", outputPath
      ], metadata.duration, onProgress, "Streams kopiëren", 0, 99);
    } catch (copyError) {
      rmSync(outputPath, { force: true });
      if (this.cancelled) throw new Error("Conversie geannuleerd.");
      onProgress({ status: "encoding", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Streams zijn niet compatibel; H.264/AAC wordt gebruikt" });
      await this.runEncoding(ffmpegPath, [
        "-y", "-fflags", "+genpts", "-i", inputPath,
        "-map", "0:v:0", "-map", "0:a:0?", "-dn", "-sn",
        "-c:v", "libx264", "-preset", settings.preset,
        "-c:a", "aac", "-b:a", `${settings.audioBitrateKbps}k`, "-movflags", "+faststart", outputPath
      ], metadata.duration, onProgress, "H.264/AAC wordt geschreven", 0, 99).catch((transcodeError) => {
        throw new Error(`MP4-conversie mislukt. Stream copy: ${(copyError as Error).message}. Hercodering: ${(transcodeError as Error).message}`);
      });
    }
  }

  private twoPass(
    ffmpegPath: string, inputPath: string, outputPath: string, workDir: string,
    metadata: VideoMetadata, settings: CompressionSettings, bitrate: number, onProgress: ProgressCallback
  ): Promise<void> {
    const passLog = join(workDir, "ffmpeg-pass");
    const common = ["-y", "-fflags", "+genpts", "-i", inputPath, "-map", "0:v:0", "-dn", "-sn"];
    const filter = resolutionFilter(metadata, settings.resolution);
    if (filter) common.push("-vf", filter);
    if (settings.frameRate !== "original") common.push("-r", String(settings.frameRate));
    common.push("-c:v", settings.videoCodec === "h265" ? "libx265" : "libx264", "-b:v", `${bitrate}k`, "-preset", settings.preset);
    const audio = settings.keepAudio
      ? ["-map", "0:a:0?", "-c:a", "aac", "-b:a", `${settings.audioBitrateKbps}k`]
      : ["-an"];
    const passOne = [...common, "-an", "-pass", "1", "-passlogfile", passLog, "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"];
    const passTwo = [...common, ...audio, "-pass", "2", "-passlogfile", passLog, "-movflags", "+faststart", outputPath];
    return this.runEncoding(ffmpegPath, passOne, metadata.duration, onProgress, "Eerste pass: beeld analyseren", 0, 46)
      .then(() => this.runEncoding(ffmpegPath, passTwo, metadata.duration, onProgress, "Tweede pass: MP4 wordt geschreven", 46, 99));
  }

  private runEncoding(
    command: string, args: string[], duration: number, onProgress: ProgressCallback,
    message: string, percentStart: number, percentEnd: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.cancelled) return reject(new Error("Conversie geannuleerd."));
      const process = new ManagedProcess(command, ["-progress", "pipe:1", "-nostats", ...args]);
      this.activeProcess = process;
      let errorOutput = "";
      let buffer = "";
      let seconds = 0;
      let speed = "";
      let bitrate = "";
      process.on("stdout", (text: string) => {
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        let changed = false;
        for (const line of lines) {
          const time = /^out_time_ms=(\d+)/.exec(line);
          const speedMatch = /^speed=(.*)/.exec(line);
          const bitrateMatch = /^bitrate=(.*)/.exec(line);
          if (time) { seconds = Number(time[1]) / 1_000_000; changed = true; }
          if (speedMatch) { speed = speedMatch[1].trim(); changed = true; }
          if (bitrateMatch) { bitrate = bitrateMatch[1].trim(); changed = true; }
        }
        if (!changed) return;
        const percent = scaleEncodingPercent(seconds, duration, percentStart, percentEnd);
        const numericSpeed = Number.parseFloat(speed);
        const etaSeconds = speed && seconds > 0 && Number.isFinite(numericSpeed) && numericSpeed > 0
          ? Math.max(0, (duration - seconds) / numericSpeed)
          : null;
        onProgress({ status: "encoding", percent, speed, etaSeconds, bitrate, message });
      });
      process.on("stderr", (text: string) => { errorOutput = (errorOutput + text).slice(-8000); });
      process.on("error", reject);
      process.on("close", (code: number | null) => {
        if (this.cancelled) reject(new Error("Conversie geannuleerd."));
        else if (code === 0) resolve();
        else reject(new Error(translateFfmpegFailure(code, errorOutput)));
      });
    });
  }
}

export function scaleEncodingPercent(seconds: number, duration: number, start: number, end: number): number {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(duration) || duration <= 0) return from;
  const ratio = Math.min(1, seconds / duration);
  return Math.min(to, Math.max(from, Math.round(from + ratio * (to - from))));
}

function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

function translateFfmpegFailure(code: number | null, errorOutput: string): string {
  const tail = errorOutput.slice(-1000);
  if (/Unknown encoder ['"]?libx265/i.test(errorOutput)) {
    return `H.265 (libx265) wordt niet ondersteund door deze FFmpeg-installatie. Kies H.264 of installeer een FFmpeg-build met libx265. ${tail}`;
  }
  if (/Permission denied|No such file or directory|Invalid argument/i.test(errorOutput)) {
    return `FFmpeg kon het bestand niet verwerken (exitcode ${code}). ${tail}`;
  }
  return `FFmpeg is gestopt met exitcode ${code}. ${tail}`;
}

function improveIoError(error: unknown, finalPath: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission denied|EPERM|EACCES|denied/i.test(message)) {
    return new Error(
      `Geen schrijfrechten voor "${finalPath}". Sluit het bestand als het open staat, of zet OneDrive tijdelijk op "Altijd behouden op dit apparaat". De MP4 wordt naast het bronbestand gezet, zonder extra map.`
    );
  }
  return error instanceof Error ? error : new Error(message);
}

function cleanupWorkDir(workDir: string): void {
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.warn(`[Compressor] Tijdelijke werkmap kon niet worden verwijderd: ${workDir}`, error);
  }
}
