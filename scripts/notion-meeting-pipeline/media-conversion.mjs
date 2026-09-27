import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  MediaPipelineError,
  assertMeetingAudioProfile,
  buildConversionArgs,
  inspectMedia,
  redactError,
  runCommand,
  sha256File,
  validatePreparedMedia,
} from "./media-core.mjs";

export async function convertToMeetingAudio(inputPath, outputPath, options = {}) {
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const run = options.run ?? runCommand;
  const inspect = options.inspect ?? ((filePath) => inspectMedia(filePath, {
    ffprobePath: options.ffprobePath,
    run: options.probeRun,
  }));
  const extension = path.extname(outputPath) || ".m4a";
  const temporary = `${outputPath}.part-${process.pid}-${Date.now()}-${randomUUID()}${extension}`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    const result = await run(ffmpegPath, buildConversionArgs(inputPath, temporary));
    if (result.exitCode !== 0) throw new MediaPipelineError("ffmpeg rejected the source media", "FFMPEG_FAILED");
    const metadata = await inspect(temporary);
    assertMeetingAudioProfile(metadata);
    const digest = await sha256File(temporary);
    const validation = validatePreparedMedia({
      sourceDurationSeconds: options.sourceDurationSeconds,
      preparedDurationSeconds: metadata.durationSeconds,
      preparedBytes: digest.bytes,
      maxBytes: options.maxBytes,
      durationToleranceSeconds: options.durationToleranceSeconds,
    });
    await rename(temporary, outputPath);
    return {
      path: outputPath,
      bytes: digest.bytes,
      sha256: digest.sha256,
      durationSeconds: metadata.durationSeconds,
      streams: metadata.streams,
      validation,
    };
  } catch (error) {
    throw error instanceof MediaPipelineError || error?.name === "PipelinePolicyError"
      ? error
      : new MediaPipelineError(`audio preparation failed: ${redactError(error)}`);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function streamResponse(response, destination, append) {
  if (!response.body) throw new MediaPipelineError("download response has no body", "DOWNLOAD_FAILED");
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination, { flags: append ? "a" : "w", mode: 0o600 }),
  );
}

export async function downloadResumable(url, destination, options = {}) {
  if (!/^https?:\/\//i.test(String(url))) throw new MediaPipelineError("source URL must use HTTP or HTTPS", "INVALID_SOURCE_URL");
  const partPath = `${destination}.part`;
  await mkdir(path.dirname(destination), { recursive: true });
  let existingBytes = 0;
  try {
    existingBytes = (await stat(partPath)).size;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (options.expectedBytes !== undefined && existingBytes > options.expectedBytes) {
    await rm(partPath, { force: true });
    existingBytes = 0;
  }
  if (options.expectedBytes && existingBytes === options.expectedBytes) {
    const existingDigest = await sha256File(partPath);
    if (!options.expectedSha256 || existingDigest.sha256 === options.expectedSha256) {
      await rename(partPath, destination);
      return { ...existingDigest, resumed: existingBytes > 0, downloaded: false };
    }
    await rm(partPath, { force: true });
    existingBytes = 0;
  }
  let response;
  try {
    response = await (options.fetch ?? fetch)(url, existingBytes > 0 ? { headers: { Range: `bytes=${existingBytes}-` } } : undefined);
  } catch (error) {
    throw new MediaPipelineError(`source download failed: ${redactError(error)}`, "DOWNLOAD_FAILED");
  }
  if (!response.ok && response.status !== 206) throw new MediaPipelineError(`source download returned HTTP ${response.status}`, "DOWNLOAD_FAILED");
  const resumed = existingBytes > 0 && response.status === 206;
  if (resumed) {
    const contentRange = response.headers.get("content-range") ?? "";
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange);
    if (!match || Number(match[1]) !== existingBytes || (options.expectedBytes !== undefined && match[3] !== "*" && Number(match[3]) !== options.expectedBytes)) {
      throw new MediaPipelineError("resumed download returned an invalid Content-Range", "DOWNLOAD_RANGE_MISMATCH");
    }
  }
  if (!resumed && existingBytes > 0) {
    await rm(partPath, { force: true });
    existingBytes = 0;
  }
  await streamResponse(response, partPath, resumed);
  const digest = await sha256File(partPath);
  if (options.expectedBytes !== undefined && digest.bytes !== options.expectedBytes) throw new MediaPipelineError(`downloaded byte count ${digest.bytes} does not match expected source`, "SOURCE_SIZE_MISMATCH");
  if (options.expectedSha256 && digest.sha256.toLowerCase() !== options.expectedSha256.toLowerCase()) throw new MediaPipelineError("downloaded source hash does not match expected source", "SOURCE_HASH_MISMATCH");
  await rename(partPath, destination);
  return { ...digest, resumed, downloaded: true };
}
