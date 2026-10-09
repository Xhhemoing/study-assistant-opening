import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MediaSegment } from "@aistudy/contracts";
import { createNodeRunner } from "./docling-process";
import { loadParserConfig, type ParserConfig } from "./parser-config";
import { MediaConfigurationError, MediaValidationError } from "./media-process";
import type { ParserRunner } from "./types";

export type TranscribeAdapterInput = {
  path: string;
  mime: string;
  durationMs: number;
  hasAudio: boolean;
  sourceId?: string;
  sourceVersion?: number;
};

/**
 * Spawn opening_parser.process_media for faster-whisper transcription.
 * Never auto-downloads weights; CONFIGURATION when missing / offline-unavailable.
 */
export function createPythonTranscribeAdapter(deps: {
  run?: ParserRunner;
  config?: ParserConfig;
  modelSize?: string;
  modelPath?: string | null;
  workDir?: string;
} = {}) {
  const config = deps.config ?? loadParserConfig();
  const run = deps.run ?? createNodeRunner(config);

  return async (input: TranscribeAdapterInput, signal: AbortSignal): Promise<MediaSegment[]> => {
    if (!input.hasAudio) return [];

    const base = deps.workDir ?? (await mkdtemp(path.join(os.tmpdir(), "opening-transcribe-")));
    const outDir = path.join(base, "out");
    await mkdir(outDir, { recursive: true });

    const argv = [
      "-m",
      "opening_parser.process_media",
      "--input",
      input.path,
      "--mime",
      input.mime,
      "--output-dir",
      outDir,
      "--skip-frames",
      "--model-size",
      deps.modelSize ?? process.env.OPENING_WHISPER_MODEL_SIZE ?? "base",
    ];
    const modelPath = deps.modelPath ?? process.env.OPENING_WHISPER_MODEL_PATH ?? null;
    if (modelPath) {
      argv.push("--model-path", modelPath);
    }

    try {
      const result = await run(argv, signal);
      const start = result.stdout.indexOf("{");
      const raw = start < 0 ? result.stdout : result.stdout.slice(start);
      let payload: {
        ok?: boolean;
        code?: string;
        error?: string;
        transcription?: string;
        transcriptionError?: string;
        segments?: Array<{ startMs: number; endMs: number; text: string; language?: string | null }>;
      };
      try {
        payload = JSON.parse(raw) as typeof payload;
      } catch {
        throw new MediaValidationError("process_media returned invalid JSON");
      }

      if (result.exitCode === 2 || payload.code === "CONFIGURATION") {
        throw new MediaConfigurationError(
          payload.transcriptionError ??
            payload.error ??
            "faster-whisper is not configured; live transcription is blocked (CONFIGURATION)",
        );
      }
      if (result.exitCode !== 0 || payload.ok === false) {
        if (payload.code === "MEDIA_VALIDATION") {
          throw new MediaValidationError(payload.error ?? "media validation failed");
        }
        throw new MediaValidationError(payload.error ?? `process_media failed (exit ${result.exitCode})`);
      }

      if (payload.transcription === "blocked_not_configured") {
        throw new MediaConfigurationError(
          payload.transcriptionError ??
            "faster-whisper model weights unavailable offline; do not auto-download unknown weights",
        );
      }
      if (payload.transcription === "skipped_no_audio") return [];

      const sourceId = input.sourceId ?? "00000000-0000-4000-8000-000000000000";
      const sourceVersion = input.sourceVersion ?? 0;
      return (payload.segments ?? []).map((segment) => ({
        sourceId,
        sourceVersion,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        frameChunkIds: [] as string[],
        quality: "needs_check" as const,
      }));
    } finally {
      if (!deps.workDir) await rm(base, { recursive: true, force: true });
    }
  };
}
