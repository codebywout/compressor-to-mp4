import { CompressionSettings, EncoderPreference, SpeedPreset } from "../shared/types";

export type EncoderFamily = "cpu" | "nvidia" | "intel" | "amd";
export type { EncoderPreference, SpeedPreset };

export interface CodecPair {
  h264: boolean;
  h265: boolean;
}

export interface HardwareCapabilities {
  nvidia: CodecPair;
  intel: CodecPair;
  amd: CodecPair;
}

export interface ResolvedEncoder {
  id: string;
  family: EncoderFamily;
  codec: "h264" | "h265";
  label: string;
  /** Classic FFmpeg -pass 1/2 (libx264/libx265). */
  supportsTwoPass: boolean;
}

export const EMPTY_HARDWARE: HardwareCapabilities = {
  nvidia: { h264: false, h265: false },
  intel: { h264: false, h265: false },
  amd: { h264: false, h265: false }
};

const SOFTWARE: Record<"h264" | "h265", string> = {
  h264: "libx264",
  h265: "libx265"
};

const HARDWARE_IDS: Record<Exclude<EncoderFamily, "cpu">, Record<"h264" | "h265", string>> = {
  nvidia: { h264: "h264_nvenc", h265: "hevc_nvenc" },
  intel: { h264: "h264_qsv", h265: "hevc_qsv" },
  amd: { h264: "h264_amf", h265: "hevc_amf" }
};

const FAMILY_LABEL: Record<EncoderFamily, string> = {
  cpu: "CPU",
  nvidia: "NVIDIA NVENC",
  intel: "Intel Quick Sync",
  amd: "AMD AMF"
};

/** Which hardware encoder names appear in `ffmpeg -encoders` output. */
export function parseHardwareListed(encoderText: string): HardwareCapabilities {
  return {
    nvidia: {
      h264: /\bh264_nvenc\b/.test(encoderText),
      h265: /\bhevc_nvenc\b/.test(encoderText)
    },
    intel: {
      h264: /\bh264_qsv\b/.test(encoderText),
      h265: /\bhevc_qsv\b/.test(encoderText)
    },
    amd: {
      h264: /\bh264_amf\b/.test(encoderText),
      h265: /\bhevc_amf\b/.test(encoderText)
    }
  };
}

export function hardwareUsable(caps: HardwareCapabilities, family: Exclude<EncoderFamily, "cpu">, codec: "h264" | "h265"): boolean {
  return caps[family][codec];
}

export function cpuEncoderId(codec: "h264" | "h265"): string {
  return SOFTWARE[codec];
}

export function selectEncoder(
  preference: EncoderPreference,
  codec: "h264" | "h265",
  hardware: HardwareCapabilities,
): ResolvedEncoder {
  const cpu = resolveFamily("cpu", codec);
  if (preference === "cpu") return cpu;

  if (preference === "nvidia" || preference === "intel" || preference === "amd") {
    if (hardwareUsable(hardware, preference, codec)) return resolveFamily(preference, codec);
    return cpu;
  }

  // auto: prefer discrete NVIDIA, then AMD, then Intel, then CPU
  for (const family of ["nvidia", "amd", "intel"] as const) {
    if (hardwareUsable(hardware, family, codec)) return resolveFamily(family, codec);
  }
  return cpu;
}

function resolveFamily(family: EncoderFamily, codec: "h264" | "h265"): ResolvedEncoder {
  const id = family === "cpu" ? SOFTWARE[codec] : HARDWARE_IDS[family][codec];
  return {
    id,
    family,
    codec,
    label: `${FAMILY_LABEL[family]} (${codec.toUpperCase()})`,
    supportsTwoPass: family === "cpu"
  };
}

/**
 * Map UI speed preset to encoder-specific flags (without -c:v / bitrate).
 */
export function encoderSpeedArgs(encoder: ResolvedEncoder, preset: SpeedPreset): string[] {
  if (encoder.family === "cpu") {
    return ["-preset", preset];
  }
  if (encoder.family === "nvidia") {
    const map: Record<SpeedPreset, string> = {
      ultrafast: "p1",
      veryfast: "p2",
      faster: "p3",
      fast: "p4",
      medium: "p5",
      slow: "p7"
    };
    return ["-preset", map[preset], "-rc", "vbr", "-multipass", "fullres"];
  }
  if (encoder.family === "amd") {
    const map: Record<SpeedPreset, string> = {
      ultrafast: "speed",
      veryfast: "speed",
      faster: "speed",
      fast: "balanced",
      medium: "balanced",
      slow: "quality"
    };
    return ["-quality", map[preset], "-rc", "vbr_latency"];
  }
  // intel qsv
  const map: Record<SpeedPreset, string> = {
    ultrafast: "veryfast",
    veryfast: "veryfast",
    faster: "faster",
    fast: "fast",
    medium: "medium",
    slow: "slow"
  };
  return ["-preset", map[preset]];
}

/** Video codec args for a target bitrate (kbps). */
export function buildVideoEncodeArgs(encoder: ResolvedEncoder, preset: SpeedPreset, bitrateKbps: number): string[] {
  const rate = Math.max(100, Math.floor(bitrateKbps));
  const maxrate = rate;
  const bufsize = rate * 2;
  return [
    "-c:v", encoder.id,
    ...encoderSpeedArgs(encoder, preset),
    "-b:v", `${rate}k`,
    "-maxrate", `${maxrate}k`,
    "-bufsize", `${bufsize}k`,
    "-pix_fmt", "yuv420p"
  ];
}

/** @deprecated Prefer computeAdaptiveConcurrency in concurrency.ts */
export function recommendedConcurrency(family: EncoderFamily, logicalCpus: number): number {
  const cpus = Number.isFinite(logicalCpus) && logicalCpus > 0 ? logicalCpus : 4;
  if (family === "cpu") return Math.max(1, Math.min(4, Math.floor(cpus / 4) || 1));
  return 2;
}

export function isEncoderPreference(value: unknown): value is EncoderPreference {
  return value === "auto" || value === "cpu" || value === "nvidia" || value === "intel" || value === "amd";
}

export function isSpeedPreset(value: unknown): value is SpeedPreset {
  return value === "ultrafast" || value === "veryfast" || value === "faster"
    || value === "fast" || value === "medium" || value === "slow";
}

export function normalizePreset(value: string | undefined): SpeedPreset {
  if (isSpeedPreset(value)) return value;
  return "medium";
}

export function preferenceLabel(preference: EncoderPreference): string {
  switch (preference) {
    case "auto": return "Automatisch";
    case "cpu": return "CPU";
    case "nvidia": return "NVIDIA";
    case "intel": return "Intel";
    case "amd": return "AMD";
  }
}

/** True when compress can remux/copy because the file already fits the target. */
export function canSkipReencodeForSize(
  originalBytes: number,
  settings: Pick<CompressionSettings, "mode" | "targetMb" | "resolution" | "frameRate">,
): boolean {
  if (settings.mode !== "compress") return false;
  if (settings.resolution !== "original") return false;
  if (settings.frameRate !== "original") return false;
  return originalBytes <= settings.targetMb * 1_000_000;
}
