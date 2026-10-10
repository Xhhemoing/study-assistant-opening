import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { MediaSegment } from "@aistudy/contracts";
import type { OpeningJobRecord, OpeningSourceChunksRepository, OpeningSourceRepository } from "@aistudy/database";
import {
  MEDIA_VIDEO_MAX_BYTES,
  MEDIA_VIDEO_MAX_DURATION_MS,
  MediaConfigurationError,
  MediaValidationError,
  createMediaProcess,
  mediaFrameObjectKey,
  type ExtractedKeyframe,
  type MediaProcess,
} from "../parsers/media-process";
import { validateMediaSegments } from "../parsers/media-segments";

const MEDIA_MIMES = new Set([
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
]);

/** Persist when faster-whisper / transcribe adapter is not configured (audio or video). */
const BLOCKED_NOT_CONFIGURED_ERROR = {
  code: "blocked_not_configured",
  message: "转写服务未配置（需 faster-whisper），原件已保存；配置完成前重试无效。",
  retryable: false,
} as const;

type Storage = {
  presignGet(
    key: string,
    input: { expiresInSeconds: number; responseContentDisposition: string; responseCacheControl: string },
  ): Promise<string>;
  finalKey(id: string, version: number): string;
};

type SourceRepo = Pick<OpeningSourceRepository, "get" | "markParseState">;

export type PutObjectFn = (input: { key: string; body: Buffer; mime: string }) => Promise<void>;

export type ParseMediaDeps = {
  sources: SourceRepo;
  chunks: Pick<OpeningSourceChunksRepository, "replaceChunks">;
  storage: Storage;
  tempDir: string;
  media?: MediaProcess;
  /**
   * Optional Python/transcription adapter. When omitted, validation-only probe
   * runs and the job records that live transcription is blocked/not configured.
   */
  transcribe?: (
    input: { path: string; mime: string; durationMs: number; hasAudio: boolean },
    signal: AbortSignal,
  ) => Promise<MediaSegment[]>;
  /**
   * Persist keyframe PNGs under the I02 opening/sources/.../frames/ layout.
   * When omitted, extracted frames stay local-only and are not linked as chunks.
   */
  putObject?: PutObjectFn;
  /** Override keyframe extraction (tests). Default uses media.extractKeyframes when hasVideo. */
  extractFrames?: (
    input: { path: string; durationMs: number; outputDir: string },
    signal: AbortSignal,
  ) => Promise<{ frames: ExtractedKeyframe[]; visualCoverageLimited: boolean }>;
};

export type ParseMediaPayload = {
  sourceId: string;
};

type ChunkRow = {
  page: number;
  slideLabel: string | null;
  startMs: number | null;
  endMs: number | null;
  text: string;
  imageObjectKey: string | null;
};

/**
 * Worker boundary for V01 media: source/version are loaded server-side only.
 * Does not load the whole media object into Web memory — streams to a temp file
 * with a declared-byte cap, then probes via ffprobe argv.
 */
export function createParseMediaHandler(deps: ParseMediaDeps) {
  const media = deps.media ?? createMediaProcess();
  const tempDir = path.resolve(deps.tempDir);

  return async (job: OpeningJobRecord, payload: unknown) => {
    const body = payload as (ParseMediaPayload & {
      mode?: string;
      correctedVersion?: number;
      segmentCount?: number;
    }) | null;
    const sourceId = body?.sourceId;
    if (typeof sourceId !== "string") throw new Error("parse-media payload missing sourceId");

    // Corrections receipt jobs reuse kind parse-media without outbox; if one is ever
    // dispatched, do not re-transcribe over user-corrected segments.
    if (body?.mode === "segments-correction") {
      return {
        ok: true,
        mode: "segments-correction",
        sourceId,
        correctedVersion: body.correctedVersion ?? null,
        segmentCount: body.segmentCount ?? null,
        claimsVisualUnderstanding: false,
        skipped: true,
      };
    }

    const scope = { workspaceId: job.workspaceId, ownerUserId: job.ownerUserId };
    const source = await deps.sources.get(scope, sourceId);
    if (source.uploadState !== "uploaded") throw new Error("source is not uploaded");
    if (!MEDIA_MIMES.has(source.mime)) {
      await deps.sources.markParseState(scope, source.id, "unsupported");
      return { unsupported: true, reason: "not a media MIME" };
    }

    const maxBytes = source.mime.startsWith("video/") ? MEDIA_VIDEO_MAX_BYTES : 200 * 1024 * 1024;
    if (source.bytes > maxBytes) {
      throw new MediaValidationError(
        `media exceeds size limit: ${source.bytes} bytes > ${maxBytes} bytes`,
      );
    }

    await mkdir(tempDir, { recursive: true });
    const temp = path.join(tempDir, `${source.id}-${source.version}.media`);
    const framesDir = path.join(tempDir, `${source.id}-${source.version}-frames`);
    const signal = new AbortController().signal;

    try {
      const url = await deps.storage.presignGet(deps.storage.finalKey(source.id, source.version), {
        expiresInSeconds: 900,
        responseContentDisposition: "attachment",
        responseCacheControl: "private, no-store",
      });
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error("source download failed");
      let bytes = 0;
      const limited = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > source.bytes) callback(new Error("source download exceeds declared bytes"));
          else callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), limited, createWriteStream(temp));

      const probe = await media.validateLocalMedia(
        {
          path: temp,
          mime: source.mime,
          maxBytes,
          maxDurationMs: MEDIA_VIDEO_MAX_DURATION_MS,
          sourceId: source.id,
          sourceVersion: source.version,
        },
        signal,
      );

      let segments: MediaSegment[] = [];
      let transcription: "completed" | "skipped_no_audio" | "blocked_not_configured" = "blocked_not_configured";

      if (!probe.hasAudio) {
        transcription = "skipped_no_audio";
        segments = [];
      } else if (deps.transcribe) {
        try {
          segments = await deps.transcribe(
            { path: temp, mime: source.mime, durationMs: probe.durationMs, hasAudio: probe.hasAudio },
            signal,
          );
          segments = validateMediaSegments(
            segments.map((s) => ({
              ...s,
              sourceId: source.id,
              sourceVersion: source.version,
            })),
            probe.durationMs,
          );
          transcription = "completed";
        } catch (error) {
          if (error instanceof MediaConfigurationError || (error as { code?: string }).code === "CONFIGURATION") {
            transcription = "blocked_not_configured";
            segments = [];
          } else {
            throw error;
          }
        }
      } else {
        transcription = "blocked_not_configured";
        segments = [];
      }

      let frames: ExtractedKeyframe[] = [];
      let visualCoverageLimited = false;
      if (probe.hasVideo) {
        const extract =
          deps.extractFrames ??
          ((input: { path: string; durationMs: number; outputDir: string }, sig: AbortSignal) =>
            media.extractKeyframes(input, sig));
        try {
          const extracted = await extract(
            { path: temp, durationMs: probe.durationMs, outputDir: framesDir },
            signal,
          );
          frames = extracted.frames;
          visualCoverageLimited = extracted.visualCoverageLimited;
        } catch (error) {
          // Keyframe failure must not invent visual understanding; keep transcript path if any.
          if (error instanceof MediaConfigurationError) {
            frames = [];
            visualCoverageLimited = false;
          } else {
            throw error;
          }
        }
      }

      const chunkRows: ChunkRow[] = [];
      for (const [index, segment] of segments.entries()) {
        chunkRows.push({
          page: index + 1,
          slideLabel: null,
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          imageObjectKey: null,
        });
      }

      const frameChunkMeta: Array<{ objectKey: string; timestampMs: number; page: number }> = [];
      if (frames.length > 0 && deps.putObject) {
        let page = chunkRows.length + 1;
        for (const frame of frames) {
          const objectKey = mediaFrameObjectKey(source.id, source.version, frame.timestampMs);
          const body = await readFile(frame.path);
          await deps.putObject({ key: objectKey, body, mime: "image/png" });
          const startMs = frame.timestampMs;
          const endMs = Math.min(probe.durationMs, Math.max(startMs + 1, startMs + 1));
          chunkRows.push({
            page,
            slideLabel: null,
            startMs,
            endMs,
            text: `[keyframe @ ${startMs}ms]`,
            imageObjectKey: objectKey,
          });
          frameChunkMeta.push({ objectKey, timestampMs: startMs, page });
          page += 1;
        }
      }

      if (chunkRows.length > 0) {
        await deps.chunks.replaceChunks(scope, {
          sourceId: source.id,
          sourceVersion: source.version,
          chunks: chunkRows,
        });
      } else if (transcription === "skipped_no_audio") {
        await deps.chunks.replaceChunks(scope, {
          sourceId: source.id,
          sourceVersion: source.version,
          chunks: [
            {
              page: 1,
              slideLabel: null,
              startMs: 0,
              endMs: Math.max(1, probe.durationMs),
              text: "[no audio track; transcription skipped — visual frames not yet attached]",
              imageObjectKey: null,
            },
          ],
        });
      } else if (transcription === "blocked_not_configured" && !probe.hasVideo) {
        await deps.sources.markParseState(scope, source.id, "failed", BLOCKED_NOT_CONFIGURED_ERROR);
        return {
          ok: false,
          transcription,
          durationMs: probe.durationMs,
          hasAudio: probe.hasAudio,
          hasVideo: probe.hasVideo,
          error: "transcription adapter not configured (faster-whisper / opening_parser.transcribe)",
        };
      } else if (transcription === "blocked_not_configured") {
        // Video without wired transcription and without persisted frames.
        await deps.sources.markParseState(scope, source.id, "failed", BLOCKED_NOT_CONFIGURED_ERROR);
        return {
          ok: false,
          transcription,
          durationMs: probe.durationMs,
          hasAudio: probe.hasAudio,
          hasVideo: probe.hasVideo,
          frameCount: frames.length,
          visualCoverageLimited,
          error:
            frames.length > 0 && !deps.putObject
              ? "keyframes extracted but putObject not configured for I02 frame persistence"
              : "transcription adapter not configured (faster-whisper / opening_parser.transcribe)",
        };
      }

      return {
        ok: true,
        transcription,
        durationMs: probe.durationMs,
        hasAudio: probe.hasAudio,
        hasVideo: probe.hasVideo,
        segmentCount: segments.length,
        frameCount: frameChunkMeta.length,
        visualCoverageLimited,
        // Audio-only / stored keyframes must never be advertised as board/slide understanding.
        claimsVisualUnderstanding: false,
      };
    } catch (error) {
      if (error instanceof MediaConfigurationError || error instanceof MediaValidationError) throw error;
      throw error;
    } finally {
      await rm(temp, { force: true });
      await rm(framesDir, { recursive: true, force: true });
    }
  };
}
