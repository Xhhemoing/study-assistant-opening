import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { MediaSegment } from "@aistudy/contracts";
import { validateMediaSegments } from "./media-segments";

/** Hard limits for opening video uploads (contracts / capability-interfaces). */
export const MEDIA_VIDEO_MAX_BYTES = 512 * 1024 * 1024;
export const MEDIA_VIDEO_MAX_DURATION_MS = 120 * 60 * 1000;
/** Keyframe caps for scene extraction (plan V01). */
export const MEDIA_MAX_FRAMES_PER_MINUTE = 2;
export const MEDIA_MAX_FRAMES_PER_FILE = 120;

const BLOCKED_PROTOCOL = /^(https?|ftp|rtmp|rtsp|mms|tcp|udp|srtp|crypto|concat|subfile|data|gopher):/i;

export class MediaConfigurationError extends Error {
  readonly code = "CONFIGURATION";
  constructor(message: string) {
    super(message);
    this.name = "MediaConfigurationError";
  }
}

export class MediaValidationError extends Error {
  readonly code = "MEDIA_VALIDATION";
  constructor(message: string) {
    super(message);
    this.name = "MediaValidationError";
  }
}

export type MediaProbe = {
  durationMs: number;
  sizeBytes: number;
  formatName: string;
  hasAudio: boolean;
  hasVideo: boolean;
  width: number | null;
  height: number | null;
};

export type ExtractMediaInput = {
  path: string;
  mime: string;
  maxDurationMs?: number;
  maxBytes?: number;
  /** Bound segments to a known source; required before persistence. */
  sourceId?: string;
  sourceVersion?: number;
};

export type MediaBinaryRunner = (
  binary: "ffprobe" | "ffmpeg",
  argv: string[],
  signal: AbortSignal,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type MediaProcessDeps = {
  run?: MediaBinaryRunner;
  ffprobePath?: string;
  ffmpegPath?: string;
};

function rejectNetworkOrRemotePath(mediaPath: string): void {
  const trimmed = mediaPath.trim();
  if (BLOCKED_PROTOCOL.test(trimmed)) {
    throw new MediaValidationError("network or remote media protocols are not allowed");
  }
  // ffprobe treats some strings as URLs even without a clear scheme; ban obvious hosts.
  if (/^(www\.|localhost[:/]|\/\/)/i.test(trimmed)) {
    throw new MediaValidationError("network or remote media protocols are not allowed");
  }
  if (!path.isAbsolute(trimmed) && (trimmed.includes("://") || trimmed.startsWith("//"))) {
    throw new MediaValidationError("network or remote media protocols are not allowed");
  }
}

/** Build ffprobe argv: JSON format probe, local file only, no shell. */
export function buildFfprobeArgv(mediaPath: string): string[] {
  rejectNetworkOrRemotePath(mediaPath);
  return [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size,format_name:stream=codec_type,width,height",
    "-of",
    "json",
    mediaPath,
  ];
}

/** Build ffmpeg argv for extracting a mono 16k wav (transcription input). */
export function buildExtractAudioArgv(mediaPath: string, outputWav: string): string[] {
  rejectNetworkOrRemotePath(mediaPath);
  if (!path.isAbsolute(outputWav) && outputWav.includes("://")) {
    throw new MediaValidationError("network or remote media protocols are not allowed");
  }
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    mediaPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "wav",
    outputWav,
  ];
}

/** Scene-change keyframes: select filter + capped frame count (caller enforces caps). */
export function buildKeyframeArgv(mediaPath: string, outputPattern: string, sceneThreshold = 0.4): string[] {
  rejectNetworkOrRemotePath(mediaPath);
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    mediaPath,
    "-vf",
    `select='gt(scene\\,${sceneThreshold})',showinfo`,
    "-vsync",
    "vfr",
    "-frames:v",
    String(MEDIA_MAX_FRAMES_PER_FILE),
    outputPattern,
  ];
}

export function createNodeMediaRunner(paths: { ffprobePath?: string; ffmpegPath?: string } = {}): MediaBinaryRunner {
  const resolveBinary = (binary: "ffprobe" | "ffmpeg") =>
    binary === "ffprobe" ? paths.ffprobePath ?? "ffprobe" : paths.ffmpegPath ?? "ffmpeg";

  return (binary, argv, signal) =>
    new Promise((resolve, reject) => {
      const child = spawn(resolveBinary(binary), argv, {
        signal,
        windowsHide: true,
        // Never use a shell — argv must remain literal.
        shell: false,
        env: { ...process.env, AV_LOG_FORCE_NOCOLOR: "1" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(stdout) < 2 * 1024 * 1024) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(stderr) < 64 * 1024) stderr += chunk.toString("utf8");
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          reject(
            new MediaConfigurationError(
              `${binary} is not installed or not on PATH; install FFmpeg to process opening media`,
            ),
          );
          return;
        }
        reject(error);
      });
      child.on("close", (exitCode) => {
        resolve({ exitCode: exitCode ?? 4, stdout, stderr: stderr.slice(-400) });
      });
    });
}

type FfprobeJson = {
  format?: { duration?: string; size?: string; format_name?: string };
  streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
};

export function parseFfprobeOutput(stdout: string): MediaProbe {
  let parsed: FfprobeJson;
  try {
    parsed = JSON.parse(stdout) as FfprobeJson;
  } catch {
    throw new MediaValidationError("ffprobe returned invalid JSON");
  }
  const durationSec = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec < 0) {
    throw new MediaValidationError("media duration is missing or invalid");
  }
  const sizeBytes = Number(parsed.format?.size ?? NaN);
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new MediaValidationError("media size is missing or invalid");
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const audio = streams.find((s) => s.codec_type === "audio");
  const video = streams.find((s) => s.codec_type === "video");
  const formatName = typeof parsed.format?.format_name === "string" ? parsed.format.format_name : "";
  if (!formatName) {
    throw new MediaValidationError("media container format is missing");
  }
  return {
    durationMs: Math.round(durationSec * 1000),
    sizeBytes,
    formatName,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
    width: video && Number.isFinite(video.width) ? Number(video.width) : null,
    height: video && Number.isFinite(video.height) ? Number(video.height) : null,
  };
}

export function assertContainerMatchesMime(probe: MediaProbe, mime: string): void {
  const names = probe.formatName.split(",").map((n) => n.trim().toLowerCase());
  const joined = probe.formatName.toLowerCase();
  if (mime === "video/mp4") {
    if (!(names.includes("mp4") || joined.includes("mp4"))) {
      throw new MediaValidationError(`container ${probe.formatName} does not match video/mp4`);
    }
    if (!probe.hasVideo) {
      throw new MediaValidationError("video/mp4 requires a video track");
    }
    return;
  }
  if (mime === "video/webm") {
    if (!(names.includes("webm") || joined.includes("webm") || names.includes("matroska"))) {
      throw new MediaValidationError(`container ${probe.formatName} does not match video/webm`);
    }
    if (!probe.hasVideo) {
      throw new MediaValidationError("video/webm requires a video track");
    }
    return;
  }
  if (mime.startsWith("audio/")) {
    if (!probe.hasAudio) {
      throw new MediaValidationError("audio source requires an audio track");
    }
    // Allow common ffprobe labels for mpeg/mp4/wav.
    if (mime === "audio/mpeg" && !(joined.includes("mp3") || joined.includes("mp2"))) {
      throw new MediaValidationError(`container ${probe.formatName} does not match audio/mpeg`);
    }
    if (mime === "audio/wav" && !joined.includes("wav")) {
      throw new MediaValidationError(`container ${probe.formatName} does not match audio/wav`);
    }
    if (mime === "audio/mp4" && !(joined.includes("mp4") || joined.includes("m4a"))) {
      throw new MediaValidationError(`container ${probe.formatName} does not match audio/mp4`);
    }
    return;
  }
  throw new MediaValidationError(`unsupported media MIME: ${mime}`);
}

export function assertWithinLimits(
  probe: MediaProbe,
  limits: { maxBytes: number; maxDurationMs: number },
): void {
  if (probe.sizeBytes > limits.maxBytes) {
    throw new MediaValidationError(
      `media exceeds size limit: ${probe.sizeBytes} bytes > ${limits.maxBytes} bytes (512MiB for video)`,
    );
  }
  if (probe.durationMs > limits.maxDurationMs) {
    throw new MediaValidationError(
      `media exceeds duration limit: ${probe.durationMs} ms > ${limits.maxDurationMs} ms (120 minutes)`,
    );
  }
}

export function maxFramesForDuration(durationMs: number): number {
  const byRate = Math.max(0, Math.ceil((durationMs / 60_000) * MEDIA_MAX_FRAMES_PER_MINUTE));
  return Math.min(MEDIA_MAX_FRAMES_PER_FILE, byRate);
}


export type ExtractedKeyframe = {
  path: string;
  timestampMs: number;
};

/** I02-style object key for a stored video keyframe (timed image chunk). */
export function mediaFrameObjectKey(sourceId: string, version: number, timestampMs: number): string {
  if (!Number.isInteger(timestampMs) || timestampMs < 0) {
    throw new MediaValidationError("keyframe timestampMs must be a non-negative integer");
  }
  return `opening/sources/${sourceId}/v${version}/frames/${timestampMs}.png`;
}

/** Parse ffmpeg showinfo pts_time lines (stderr) into seconds. */
export function parseShowinfoTimestamps(stderr: string): number[] {
  const times: number[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes("pts_time:")) continue;
    const part = line.split("pts_time:")[1]?.split(/\s+/)[0];
    if (part == null) continue;
    const value = Number(part);
    if (Number.isFinite(value) && value >= 0) times.push(value);
  }
  return times;
}

export function createMediaProcess(deps: MediaProcessDeps = {}) {
  const run = deps.run ?? createNodeMediaRunner({ ffprobePath: deps.ffprobePath, ffmpegPath: deps.ffmpegPath });

  async function probeMedia(mediaPath: string, signal: AbortSignal): Promise<MediaProbe> {
    const argv = buildFfprobeArgv(mediaPath);
    const result = await run("ffprobe", argv, signal);
    if (result.exitCode !== 0) {
      const detail = result.stderr ? `: ${result.stderr.slice(-200)}` : "";
      throw new MediaValidationError(`ffprobe failed${detail}`);
    }
    return parseFfprobeOutput(result.stdout);
  }

  async function validateLocalMedia(
    input: ExtractMediaInput,
    signal: AbortSignal,
  ): Promise<MediaProbe> {
    rejectNetworkOrRemotePath(input.path);
    let sizeBytes: number;
    try {
      const info = await stat(input.path);
      sizeBytes = info.size;
    } catch {
      throw new MediaValidationError("media file is missing or unreadable");
    }
    const maxBytes = input.maxBytes ?? (input.mime.startsWith("video/") ? MEDIA_VIDEO_MAX_BYTES : 200 * 1024 * 1024);
    if (sizeBytes > maxBytes) {
      throw new MediaValidationError(
        `media exceeds size limit: ${sizeBytes} bytes > ${maxBytes} bytes`,
      );
    }
    const probe = await probeMedia(input.path, signal);
    // Prefer on-disk size when ffprobe size is oddly zero/missing handling already done.
    const merged: MediaProbe = { ...probe, sizeBytes: Math.max(probe.sizeBytes, sizeBytes) };
    const maxDurationMs = input.maxDurationMs ?? MEDIA_VIDEO_MAX_DURATION_MS;
    assertContainerMatchesMime(merged, input.mime);
    assertWithinLimits(merged, { maxBytes, maxDurationMs });
    return merged;
  }

  /**
   * Probe + validate only. Live transcription uses the Python adapter;
   * keyframes may be extracted here via extractKeyframes for I02 persistence.
   * Never loads the whole media file into Web/process memory as a single buffer.
   */
  async function extractMedia(input: ExtractMediaInput, signal: AbortSignal): Promise<MediaSegment[]> {
    const probe = await validateLocalMedia(input, signal);
    if (!probe.hasAudio) {
      // Silent video / board-only: no transcription claim; empty segments until frames land.
      return [];
    }
    // Placeholder segments are not invented here — the worker job invokes Python
    // transcription and then validateMediaSegments against probe.durationMs.
    if (input.sourceId != null && input.sourceVersion != null) {
      return validateMediaSegments([], probe.durationMs);
    }
    return [];
  }

  /**
   * Scene-change keyframes via ffmpeg argv. Caps at 2/min and 120/file.
   * Returns local PNG paths with original media timestamps when showinfo is present.
   * Does not upload — caller persists via I02 imageObjectKey layout.
   */
  async function extractKeyframes(
    input: { path: string; durationMs: number; outputDir: string; sceneThreshold?: number },
    signal: AbortSignal,
  ): Promise<{ frames: ExtractedKeyframe[]; visualCoverageLimited: boolean }> {
    rejectNetworkOrRemotePath(input.path);
    const cap = maxFramesForDuration(input.durationMs);
    if (cap < 1) return { frames: [], visualCoverageLimited: false };
    const { mkdir } = await import("node:fs/promises");
    await mkdir(input.outputDir, { recursive: true });
    const pattern = path.join(input.outputDir, "frame-%04d.png");
    const argv = buildKeyframeArgv(input.path, pattern, input.sceneThreshold ?? 0.4);
    // buildKeyframeArgv uses MEDIA_MAX_FRAMES_PER_FILE; override -frames:v to duration cap.
    const framesIdx = argv.indexOf("-frames:v");
    if (framesIdx >= 0 && argv[framesIdx + 1] != null) argv[framesIdx + 1] = String(cap);
    const result = await run("ffmpeg", argv, signal);
    if (result.exitCode !== 0) {
      const detail = result.stderr ? `: ${result.stderr.slice(-200)}` : "";
      throw new MediaValidationError(`ffmpeg keyframe extract failed${detail}`);
    }
    const { readdir } = await import("node:fs/promises");
    const names = (await readdir(input.outputDir))
      .filter((name) => /^frame-\d+\.png$/i.test(name))
      .sort();
    const times = parseShowinfoTimestamps(result.stderr);
    const frames: ExtractedKeyframe[] = names.map((name, index) => {
      const filePath = path.join(input.outputDir, name);
      const tsMs =
        index < times.length
          ? Math.round(times[index]! * 1000)
          : Math.round((index / Math.max(names.length, 1)) * input.durationMs);
      return { path: filePath, timestampMs: tsMs };
    });
    // Hitting -frames:v cap means further scenes may have been dropped.
    const visualCoverageLimited = frames.length >= cap && cap > 0;
    return { frames, visualCoverageLimited };
  }

  return {
    probeMedia,
    validateLocalMedia,
    extractMedia,
    extractKeyframes,
    run,
  };
}

export type MediaProcess = ReturnType<typeof createMediaProcess>;
