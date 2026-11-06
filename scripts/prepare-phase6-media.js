#!/usr/bin/env node
/**
 * Prepare representative Phase 6 media (public samples + generated clips).
 * Does not use personal user videos.
 *
 * Usage: node scripts/prepare-phase6-media.js [ffmpegPath] [outDir]
 */
const { spawnSync } = require("node:child_process");
const { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

const DEFAULT_OUT = join(tmpdir(), "vc-phase6-media");

function run(ffmpeg, args) {
  const result = spawnSync(ffmpeg, args, { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${result.status}): ${(result.stderr || "").slice(-800)}`);
  }
}

async function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 1000) return dest;
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
    return dest;
  } catch (fetchError) {
    // Node fetch can fail behind some Windows network stacks; curl is more reliable.
    const curl = spawnSync("curl.exe", ["-L", "--fail", "--retry", "2", "--max-time", "120", "-o", dest, url], {
      encoding: "utf8",
      windowsHide: true
    });
    if (curl.status === 0 && existsSync(dest) && statSync(dest).size > 1000) return dest;
    throw new Error(`Download failed (${fetchError.message}); curl exit=${curl.status}`);
  }
}

function probe(ffprobe, file) {
  const result = spawnSync(ffprobe, [
    "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    return null;
  }
}

function summarize(ffprobe, file, label, kind) {
  const info = probe(ffprobe, file);
  const video = info?.streams?.find((s) => s.codec_type === "video");
  const audio = info?.streams?.find((s) => s.codec_type === "audio");
  const fpsParts = String(video?.avg_frame_rate || video?.r_frame_rate || "0/1").split("/");
  const fps = Number(fpsParts[0]) / Math.max(1, Number(fpsParts[1] || 1));
  return {
    id: label,
    kind,
    path: file,
    sizeBytes: statSync(file).size,
    duration: Number(info?.format?.duration || 0),
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    frameRate: Number.isFinite(fps) ? Number(fps.toFixed(3)) : 0,
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    container: info?.format?.format_name || null
  };
}

async function main() {
  const ffmpeg = process.argv[2] || "ffmpeg";
  const outDir = process.argv[3] || DEFAULT_OUT;
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  mkdirSync(outDir, { recursive: true });

  const catalog = [];

  // Public sample (~5.5 MB, motion + audio)
  const publicBunny = join(outDir, "public-bbb-short.mp4");
  try {
    await download(
      "https://github.com/mediaelement/mediaelement-files/raw/master/big_buck_bunny.mp4",
      publicBunny
    );
    catalog.push(summarize(ffprobe, publicBunny, "public_bbb_short", "public"));
  } catch (error) {
    console.warn(`[prepare] public sample skipped: ${error.message}`);
  }

  // Public sample (smaller, quieter content)
  const publicSmall = join(outDir, "public-sample-640.mp4");
  try {
    await download("https://filesamples.com/samples/video/mp4/sample_640x360.mp4", publicSmall);
    catalog.push(summarize(ffprobe, publicSmall, "public_sample_640", "public"));
  } catch (error) {
    console.warn(`[prepare] small public sample skipped: ${error.message}`);
  }

  // Smartphone-like: mild noise + motion, AAC stereo, H.264 1080p30
  const phone = join(outDir, "phone-like-1080p-20s.mp4");
  if (!existsSync(phone)) {
    run(ffmpeg, [
      "-y", "-f", "lavfi", "-i",
      "testsrc2=size=1920x1080:rate=30,format=yuv420p,noise=alls=12:allf=t+u",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=20",
      "-t", "20", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "128k", "-shortest", phone
    ]);
  }
  catalog.push(summarize(ffprobe, phone, "phone_like_1080p", "generated"));

  // Screen-recording-like: mostly static UI panels + sparse motion (no font deps)
  const screen = join(outDir, "screen-like-1080p-25s.mp4");
  if (!existsSync(screen)) {
    run(ffmpeg, [
      "-y", "-f", "lavfi", "-i",
      "color=c=#1e1e1e:s=1920x1080:r=30,drawgrid=w=80:h=40:t=1:c=#333333@0.6,drawbox=x=40:y=40:w=420:h=48:color=white@0.85:t=fill,drawbox=x=200:y=200:w=600:h=300:color=#0078d4@0.85:t=fill,drawbox=x=860:y=200:w=400:h=24:color=#3c3c3c@0.9:t=fill",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
      "-t", "25", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-c:a", "aac", "-b:a", "96k", "-shortest", screen
    ]);
  }
  catalog.push(summarize(ffprobe, screen, "screen_like_1080p", "generated"));

  // High motion
  const motion = join(outDir, "high-motion-1080p-15s.mp4");
  if (!existsSync(motion)) {
    run(ffmpeg, [
      "-y", "-f", "lavfi", "-i",
      "mandelbrot=size=1920x1080:rate=60:maxiter=100",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=15",
      "-t", "15", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-c:a", "aac", "-b:a", "160k", "-shortest", motion
    ]);
  }
  catalog.push(summarize(ffprobe, motion, "high_motion_1080p60", "generated"));

  // 4K short
  const uhd = join(outDir, "uhd-like-4k-12s.mp4");
  if (!existsSync(uhd)) {
    run(ffmpeg, [
      "-y", "-f", "lavfi", "-i",
      "testsrc2=size=3840x2160:rate=30,format=yuv420p,noise=alls=8:allf=t",
      "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=12",
      "-t", "12", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "128k", "-shortest", uhd
    ]);
  }
  catalog.push(summarize(ffprobe, uhd, "uhd_like_4k", "generated"));

  // H.265 source (HEVC)
  const hevc = join(outDir, "hevc-source-720p-15s.mp4");
  if (!existsSync(hevc)) {
    run(ffmpeg, [
      "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25,format=yuv420p",
      "-f", "lavfi", "-i", "sine=frequency=520:sample_rate=48000:duration=15",
      "-t", "15", "-c:v", "libx265", "-preset", "veryfast", "-crf", "22", "-tag:v", "hvc1",
      "-c:a", "aac", "-b:a", "96k", "-shortest", hevc
    ]);
  }
  catalog.push(summarize(ffprobe, hevc, "hevc_source_720p", "generated"));

  // MPEG-TS container (classic TS→MP4 path)
  const ts = join(outDir, "broadcast-like-1080p-18s.ts");
  if (!existsSync(ts)) {
    run(ffmpeg, [
      "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=25,format=yuv420p",
      "-f", "lavfi", "-i", "sine=frequency=600:sample_rate=48000:duration=18",
      "-t", "18", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "4M",
      "-c:a", "aac", "-b:a", "128k", "-shortest", "-f", "mpegts", ts
    ]);
  }
  catalog.push(summarize(ffprobe, ts, "ts_broadcast_like", "generated"));

  // No audio
  const silent = join(outDir, "silent-720p-10s.mp4");
  if (!existsSync(silent)) {
    run(ffmpeg, [
      "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30,format=yuv420p",
      "-t", "10", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", silent
    ]);
  }
  catalog.push(summarize(ffprobe, silent, "silent_720p", "generated"));

  // Special-character / long filename copies for path stress
  const specialDir = join(outDir, "pad test — café & 日本語");
  mkdirSync(specialDir, { recursive: true });
  const specialName = join(specialDir, "clip (final) #1 — zomer_2024.mp4");
  if (!existsSync(specialName) && existsSync(phone)) {
    run(ffmpeg, ["-y", "-i", phone, "-t", "8", "-c", "copy", specialName]);
  }
  if (existsSync(specialName)) {
    catalog.push(summarize(ffprobe, specialName, "special_chars_name", "generated"));
  }

  const manifest = join(outDir, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ createdAt: new Date().toISOString(), outDir, files: catalog }, null, 2));
  console.log(JSON.stringify({ ok: true, outDir, count: catalog.length, manifest }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
