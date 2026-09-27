import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  DEFAULT_DURATION_TOLERANCE_SECONDS,
  DEFAULT_FRONTEND_UPLOAD_LIMIT_BYTES,
  assertCompleteDuration,
  assertUploadSize,
} from "./policy.mjs";

export class MediaPipelineError extends Error {
  constructor(message, code = "MEDIA_FAILED") {
    super(message);
    this.name = "MediaPipelineError";
    this.code = code;
  }
}

export function redactError(error) {
  return String(error?.message ?? error ?? "media operation failed")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/(?:ntn|secret)_[A-Za-z0-9_-]+/g, "<token>")
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{8,}/g, "<credential>")
    .replace(/X-Amz-[A-Za-z-]+/gi, "<signed-field>")
    .replace(/\bBearer\s+[^\s,}]+/ig, "<redacted-auth>")
    .replace(/\b(?:authorization|credential|signature|security-token)\b\s*[:=]?\s*[^,;}\n]*/ig, "<redacted-sensitive-field>");
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(filePath)) {
      bytes += chunk.length;
      hash.update(chunk);
    }
  } catch (error) {
    throw new MediaPipelineError(`cannot hash media file: ${redactError(error)}`, "HASH_FAILED");
  }
  return { bytes, sha256: hash.digest("hex") };
}

export async function assertFileDigest(filePath, expected) {
  const actual = await sha256File(filePath);
  if (
    actual.bytes !== expected?.bytes
    || actual.sha256.toLowerCase() !== String(expected?.sha256 ?? "").toLowerCase()
  ) {
    throw new MediaPipelineError(
      `file digest does not match persisted manifest for ${path.basename(filePath)}`,
      "FILE_DIGEST_MISMATCH",
    );
  }
  return actual;
}

export function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? -1 }));
  });
}

export function buildConversionArgs(inputPath, outputPath) {
  return [
    "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
    "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "aac", "-b:a", "32k", "-movflags", "+faststart", outputPath,
  ];
}

export async function inspectMedia(filePath, options = {}) {
  const ffprobePath = options.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe";
  const run = options.run ?? runCommand;
  let result;
  try {
    result = await run(ffprobePath, [
      "-v", "error", "-show_streams", "-show_format", "-of", "json", filePath,
    ]);
  } catch (error) {
    throw new MediaPipelineError(`ffprobe could not start: ${redactError(error)}`, "FFPROBE_FAILED");
  }
  if (result.exitCode !== 0) throw new MediaPipelineError("ffprobe rejected the media file", "FFPROBE_FAILED");
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new MediaPipelineError("ffprobe returned invalid metadata", "FFPROBE_FAILED");
  }
  const durationSeconds = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new MediaPipelineError("media duration is missing or invalid", "INVALID_MEDIA_DURATION");
  }
  return {
    path: filePath,
    durationSeconds,
    formatName: parsed.format?.format_name ?? null,
    streams: Array.isArray(parsed.streams)
      ? parsed.streams.map((stream) => ({
        codecType: stream.codec_type ?? null,
        codecName: stream.codec_name ?? null,
        sampleRate: stream.sample_rate ? Number(stream.sample_rate) : null,
        channels: stream.channels ? Number(stream.channels) : null,
      }))
      : [],
  };
}

export function assertMeetingAudioProfile(metadata) {
  const audio = metadata?.streams?.find((stream) => stream?.codecType === "audio");
  if (audio?.codecName !== "aac" || audio?.sampleRate !== 16_000 || audio?.channels !== 1) {
    throw new MediaPipelineError(
      "prepared media must contain a 16 kHz mono AAC audio stream",
      "INVALID_MEETING_AUDIO_PROFILE",
    );
  }
  return { accepted: true, codecName: audio.codecName, sampleRate: audio.sampleRate, channels: audio.channels };
}

export function validatePreparedMedia({
  sourceDurationSeconds,
  preparedDurationSeconds,
  preparedBytes,
  maxBytes = DEFAULT_FRONTEND_UPLOAD_LIMIT_BYTES,
  durationToleranceSeconds = DEFAULT_DURATION_TOLERANCE_SECONDS,
}) {
  const duration = assertCompleteDuration(preparedDurationSeconds, sourceDurationSeconds, durationToleranceSeconds);
  if (!Number.isInteger(preparedBytes) || preparedBytes <= 0) {
    throw new MediaPipelineError("prepared media has no positive byte count", "INVALID_MEDIA_SIZE");
  }
  if (preparedBytes >= maxBytes) {
    throw new MediaPipelineError(`prepared media size is ${preparedBytes} bytes; limit is ${maxBytes} bytes`, "UPLOAD_TOO_LARGE");
  }
  return { ...duration, bytes: preparedBytes, size: assertUploadSize(preparedBytes, maxBytes) };
}

export async function readFileBytes(filePath) {
  return readFile(filePath);
}
