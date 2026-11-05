import { runProcess } from "./process";
import { VideoMetadata } from "../shared/types";
import { statSync } from "node:fs";

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
}

interface ProbeResult {
  format?: { duration?: string };
  streams?: ProbeStream[];
}

function frameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split("/").map(Number);
  return denominator ? numerator / denominator : Number(value);
}

export async function probeFile(ffprobePath: string, inputPath: string): Promise<VideoMetadata> {
  const output = await runProcess(ffprobePath, [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", inputPath
  ]);
  const data = JSON.parse(output) as ProbeResult;
  const streams = data.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video?.width || !video.height) throw new Error("Geen bruikbare videostream gevonden.");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("De videoduur kon niet worden bepaald.");
  return {
    size: statSync(inputPath).size,
    duration,
    width: video.width,
    height: video.height,
    frameRate: frameRate(video.r_frame_rate),
    videoCodec: video.codec_name ?? "onbekend",
    audioCodec: audio?.codec_name ?? null,
    audioChannels: audio?.channels ?? null,
    audioSampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null
  };
}
