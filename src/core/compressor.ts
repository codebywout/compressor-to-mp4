import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { calculateVideoBitrateKbps, resolutionFilter } from "./bitrate";
import {
  buildVideoEncodeArgs,
  canSkipReencodeForSize,
  EMPTY_HARDWARE,
  HardwareCapabilities,
  ResolvedEncoder,
  selectEncoder,
  normalizePreset
} from "./encoders";
import { OutputPathAllocator } from "./output-paths";
import { ManagedProcess } from "./process";
import {
  CompressionProgress,
  CompressionResult,
  CompressionSettings,
  EncodingPerformance,
  EncoderPreference,
  VideoMetadata
} from "../shared/types";

type ProgressCallback = (progress: CompressionProgress) => void;

export interface CompressOptions {
  outputDirectory?: string;
  outputAllocator?: OutputPathAllocator;
  hardware?: HardwareCapabilities;
}

export class Compressor {
  private activeProcess: ManagedProcess | null = null;
  private cancelled = false;
  private lastProgressAt = 0;

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
    this.lastProgressAt = 0;

    const startedAt = Date.now();
    const allocator = options.outputAllocator ?? new OutputPathAllocator();
    let reservedPath = allocator.reserveFromInput(inputPath, options.outputDirectory);
    const originalBytes = statSync(inputPath).size;
    const workDir = mkdtempSync(join(tmpdir(), "vc-work-"));
    const tempOutput = join(workDir, "output.mp4");
    const hardware = options.hardware ?? EMPTY_HARDWARE;
    const preference: EncoderPreference = settings.encoderPreference ?? "auto";
    const preset = normalizePreset(settings.preset);

    let videoBitrateKbps = 0;
    let resolved = selectEncoder(preference, settings.videoCodec, hardware);
    let fellBackToCpu = false;
    let attempts = 0;
    let encodingMs = 0;

    const emit = (progress: CompressionProgress): void => {
      onProgress({ ...progress, encoderLabel: resolved.label });
    };

    try {
      if (settings.mode === "convert") {
        const encodeStarted = Date.now();
        await this.convert(ffmpegPath, inputPath, tempOutput, metadata, settings, emit);
        encodingMs = Date.now() - encodeStarted;
        resolved = { id: "copy-or-libx264", family: "cpu", codec: "h264", label: "Conversie (copy/CPU)", supportsTwoPass: false };
      } else {
        let skipEncode = false;
        if (canSkipReencodeForSize(originalBytes, settings)) {
          emit({ status: "encoding", percent: 5, speed: "", etaSeconds: null, bitrate: "", message: "Bestand past al binnen de limiet; streams worden gekopieerd" });
          const encodeStarted = Date.now();
          try {
            await this.remuxCopy(ffmpegPath, inputPath, tempOutput, metadata, emit);
            encodingMs = Date.now() - encodeStarted;
            resolved = { id: "copy", family: "cpu", codec: settings.videoCodec, label: "Stream copy (limiet gehaald)", supportsTwoPass: false };
            skipEncode = true;
          } catch {
            rmSync(tempOutput, { force: true });
            encodingMs = 0;
            emit({ status: "encoding", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Stream copy mislukt; er wordt gecomprimeerd" });
          }
        }

        let bitrate = calculateVideoBitrateKbps(settings.targetMb, metadata.duration, settings);
        let success = skipEncode;
        let useEncoder = resolved;

        for (let attempt = 0; !skipEncode && attempt < 3; attempt++) {
          if (this.cancelled) throw new Error("Conversie geannuleerd.");
          attempts = attempt + 1;
          emit({
            status: "encoding",
            percent: 0,
            speed: "",
            etaSeconds: null,
            bitrate: `${bitrate} kb/s`,
            message: `${useEncoder.label} · poging ${attempt + 1}/3`
          });
          rmSync(tempOutput, { force: true });
          const encodeStarted = Date.now();
          try {
            if (useEncoder.supportsTwoPass) {
              await this.twoPass(ffmpegPath, inputPath, tempOutput, workDir, metadata, settings, bitrate, useEncoder, emit);
            } else {
              await this.singlePass(ffmpegPath, inputPath, tempOutput, metadata, settings, bitrate, useEncoder, emit);
            }
          } catch (error) {
            encodingMs += Date.now() - encodeStarted;
            if (this.cancelled) throw error;
            if (useEncoder.family !== "cpu" && isHardwareEncoderFailure(error)) {
              fellBackToCpu = true;
              useEncoder = selectEncoder("cpu", settings.videoCodec, EMPTY_HARDWARE);
              resolved = useEncoder;
              emit({
                status: "encoding",
                percent: 0,
                speed: "",
                etaSeconds: null,
                bitrate: `${bitrate} kb/s`,
                message: `Hardware-encoding mislukt; terugval op ${useEncoder.label}`
              });
              attempt -= 1;
              continue;
            }
            throw error;
          }
          encodingMs += Date.now() - encodeStarted;
          const outputBytes = statSync(tempOutput).size;
          if (outputBytes <= settings.targetMb * 1_000_000) {
            videoBitrateKbps = bitrate;
            success = true;
            resolved = useEncoder;
            break;
          }
          bitrate = Math.max(100, Math.floor(bitrate * (settings.targetMb * 1_000_000 / outputBytes) * 0.97));
        }
        if (!success) throw new Error("FFmpeg kon de ingestelde maximale bestandsgrootte niet bereiken.");
      }

      if (this.cancelled) throw new Error("Conversie geannuleerd.");
      if (!existsSync(tempOutput)) throw new Error("Het tijdelijke uitvoerbestand ontbreekt na encoding.");

      emit({ status: "encoding", percent: 99, speed: "", etaSeconds: null, bitrate: "", message: "MP4 wordt opgeslagen naast het bronbestand" });
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
      const moveStarted = Date.now();
      moveFile(tempOutput, reservedPath);
      const moveMs = Date.now() - moveStarted;
      if (!existsSync(reservedPath)) {
        throw new Error(`Uitvoerbestand kon niet veilig worden aangemaakt: verplaatsen naar "${reservedPath}" is mislukt.`);
      }
      const outputBytes = statSync(reservedPath).size;
      const totalMs = Date.now() - startedAt;
      const averageFps = metadata.frameRate > 0 && encodingMs > 0
        ? Number(((metadata.duration * metadata.frameRate) / (encodingMs / 1000)).toFixed(1))
        : null;
      const performance: EncodingPerformance = {
        encoderId: resolved.id,
        encoderLabel: resolved.label,
        preset,
        preference,
        fellBackToCpu,
        attempts,
        encodingMs,
        moveMs,
        totalMs,
        averageFps
      };
      return {
        inputPath,
        outputPath: reservedPath,
        originalBytes,
        outputBytes,
        duration: metadata.duration,
        videoBitrateKbps,
        settings: { ...settings, preset, encoderPreference: preference },
        metadata,
        performance
      };
    } catch (error) {
      rmSync(tempOutput, { force: true });
      throw improveIoError(error, reservedPath);
    } finally {
      allocator.release(reservedPath);
      cleanupWorkDir(workDir);
      this.activeProcess = null;
    }
  }

  private remuxCopy(
    ffmpegPath: string, inputPath: string, outputPath: string, metadata: VideoMetadata, onProgress: ProgressCallback
  ): Promise<void> {
    return this.runEncoding(ffmpegPath, [
      "-y", "-fflags", "+genpts", "-i", inputPath,
      "-map", "0:v:0", "-map", "0:a:0?", "-dn", "-sn",
      "-c", "copy", "-movflags", "+faststart", outputPath
    ], metadata.duration, onProgress, "Streams kopiëren", 0, 99);
  }

  private async convert(
    ffmpegPath: string, inputPath: string, outputPath: string, metadata: VideoMetadata,
    settings: CompressionSettings, onProgress: ProgressCallback
  ): Promise<void> {
    try {
      onProgress({ status: "encoding", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Streams worden zonder hercodering gekopieerd" });
      await this.remuxCopy(ffmpegPath, inputPath, outputPath, metadata, onProgress);
    } catch (copyError) {
      rmSync(outputPath, { force: true });
      if (this.cancelled) throw new Error("Conversie geannuleerd.");
      onProgress({ status: "encoding", percent: 0, speed: "", etaSeconds: null, bitrate: "", message: "Streams zijn niet compatibel; H.264/AAC wordt gebruikt" });
      const preset = normalizePreset(settings.preset);
      await this.runEncoding(ffmpegPath, [
        "-y", "-fflags", "+genpts", "-i", inputPath,
        "-map", "0:v:0", "-map", "0:a:0?", "-dn", "-sn",
        "-c:v", "libx264", "-preset", preset, "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", `${settings.audioBitrateKbps}k`, "-movflags", "+faststart", outputPath
      ], metadata.duration, onProgress, "H.264/AAC wordt geschreven", 0, 99).catch((transcodeError) => {
        throw new Error(`MP4-conversie mislukt. Stream copy: ${(copyError as Error).message}. Hercodering: ${(transcodeError as Error).message}`);
      });
    }
  }

  private twoPass(
    ffmpegPath: string, inputPath: string, outputPath: string, workDir: string,
    metadata: VideoMetadata, settings: CompressionSettings, bitrate: number,
    encoder: ResolvedEncoder, onProgress: ProgressCallback
  ): Promise<void> {
    const passLog = join(workDir, "ffmpeg-pass");
    const common = this.commonInputArgs(inputPath, metadata, settings);
    const video = buildVideoEncodeArgs(encoder, normalizePreset(settings.preset), bitrate);
    const audio = settings.keepAudio
      ? ["-map", "0:a:0?", "-c:a", "aac", "-b:a", `${settings.audioBitrateKbps}k`]
      : ["-an"];
    const passOne = [...common, ...video, "-an", "-pass", "1", "-passlogfile", passLog, "-f", "null", process.platform === "win32" ? "NUL" : "/dev/null"];
    const passTwo = [...common, ...video, ...audio, "-pass", "2", "-passlogfile", passLog, "-movflags", "+faststart", outputPath];
    return this.runEncoding(ffmpegPath, passOne, metadata.duration, onProgress, `Eerste pass (${encoder.label})`, 0, 46)
      .then(() => this.runEncoding(ffmpegPath, passTwo, metadata.duration, onProgress, `Tweede pass (${encoder.label})`, 46, 99));
  }

  private singlePass(
    ffmpegPath: string, inputPath: string, outputPath: string,
    metadata: VideoMetadata, settings: CompressionSettings, bitrate: number,
    encoder: ResolvedEncoder, onProgress: ProgressCallback
  ): Promise<void> {
    const args = [
      ...this.commonInputArgs(inputPath, metadata, settings),
      ...buildVideoEncodeArgs(encoder, normalizePreset(settings.preset), bitrate),
      ...(settings.keepAudio
        ? ["-map", "0:a:0?", "-c:a", "aac", "-b:a", `${settings.audioBitrateKbps}k`]
        : ["-an"]),
      "-movflags", "+faststart", outputPath
    ];
    return this.runEncoding(ffmpegPath, args, metadata.duration, onProgress, `Encoding (${encoder.label})`, 0, 99);
  }

  private commonInputArgs(inputPath: string, metadata: VideoMetadata, settings: CompressionSettings): string[] {
    const common = ["-y", "-fflags", "+genpts", "-i", inputPath, "-map", "0:v:0", "-dn", "-sn"];
    const filter = resolutionFilter(metadata, settings.resolution);
    if (filter) common.push("-vf", filter);
    if (settings.frameRate !== "original") common.push("-r", String(settings.frameRate));
    return common;
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
      let lastPercent = -1;
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
        const now = Date.now();
        if (percent === lastPercent && now - this.lastProgressAt < 120) return;
        if (now - this.lastProgressAt < 80 && percent < percentEnd - 1) return;
        this.lastProgressAt = now;
        lastPercent = percent;
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

function isHardwareEncoderFailure(error: unknown): boolean {
  const message = sanitizeFfmpegLog(error instanceof Error ? error.message : String(error));
  return /nvenc|amf|qsv|nvcuda|OpenEncodeSession|Cannot load|No NVENC|not supported|mfx|encoder.*not found|Unknown encoder/i.test(message);
}

/** Drop FFmpeg configure dumps so --enable-nvenc/amf/qsv do not trigger false hardware errors. */
export function sanitizeFfmpegLog(errorOutput: string): string {
  return errorOutput
    .split(/\r?\n/)
    .filter((line) => !/^\s*configuration:/i.test(line) && !/--enable-[a-z0-9_-]+/i.test(line))
    .join("\n");
}

function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

export function translateFfmpegFailure(code: number | null, errorOutput: string): string {
  const cleaned = sanitizeFfmpegLog(errorOutput);
  const tail = cleaned.slice(-1000);
  if (/Unknown encoder ['"]?libx265/i.test(cleaned)) {
    return `H.265 (libx265) wordt niet ondersteund door deze FFmpeg-installatie. Kies H.264 of installeer een FFmpeg-build met libx265. ${tail}`;
  }
  if (/nvenc|nvcuda|OpenEncodeSession/i.test(cleaned)) {
    return `NVIDIA NVENC is mislukt. Controleer de GPU-driver of kies CPU-encoding. ${tail}`;
  }
  if (/\bamf\b|AMF/i.test(cleaned)) {
    return `AMD AMF-encoding is mislukt. Controleer de GPU-driver of kies CPU-encoding. ${tail}`;
  }
  if (/\bqsv\b|\bmfx\b|MFX/i.test(cleaned)) {
    return `Intel Quick Sync is mislukt. Controleer de GPU-driver of kies CPU-encoding. ${tail}`;
  }
  if (/Permission denied|No such file or directory|Invalid argument|Invalid data found|moov atom not found|Invalidated/i.test(cleaned)) {
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
