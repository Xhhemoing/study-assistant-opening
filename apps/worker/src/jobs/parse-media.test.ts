import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningJobRecord } from "@aistudy/database";
import { createParseMediaHandler } from "./parse-media";
import { createMediaProcess, MediaValidationError } from "../parsers/media-process";

const sourceId = "11111111-1111-4111-8111-111111111111";
const scope = {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  ownerUserId: "33333333-3333-4333-8333-333333333333",
};
const job = {
  id: "job",
  ...scope,
  key: "key",
  kind: "parse-media",
  payload: { sourceId },
  result: null,
  state: "queued",
  privacyEpoch: 0,
} as OpeningJobRecord;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    // temp media files must be cleaned by the handler
    expect(await readdir(dir)).toEqual([]);
  }
});

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: sourceId,
    workspaceId: scope.workspaceId,
    name: "lecture.mp4",
    mime: "video/mp4",
    bytes: 64,
    sha256: "a".repeat(64),
    version: 1,
    uploadState: "uploaded",
    parseState: "queued",
    error: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("parse-media handler", () => {
  it("marks non-media unsupported without downloading", async () => {
    const states: string[] = [];
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "opening-parse-media-"));
    dirs.push(tempDir);
    const handler = createParseMediaHandler({
      sources: {
        get: async () => source({ mime: "application/pdf" }),
        markParseState: async (_s, _id, state) => {
          states.push(state);
          return source({ mime: "application/pdf" });
        },
      },
      chunks: { replaceChunks: async () => undefined },
      storage: {
        finalKey: () => "k",
        presignGet: async () => {
          throw new Error("should not download");
        },
      },
      tempDir,
    });
    const result = await handler(job, { sourceId });
    expect(result).toEqual({ unsupported: true, reason: "not a media MIME" });
    expect(states).toEqual(["unsupported"]);
    expect(await readdir(tempDir)).toEqual([]);
  });

  it("rejects oversize declared bytes before download", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "opening-parse-media-"));
    dirs.push(tempDir);
    const handler = createParseMediaHandler({
      sources: {
        get: async () => source({ bytes: 513 * 1024 * 1024 }),
        markParseState: async () => source(),
      },
      chunks: { replaceChunks: async () => undefined },
      storage: {
        finalKey: () => "k",
        presignGet: async () => {
          throw new Error("should not download");
        },
      },
      tempDir,
    });
    await expect(handler(job, { sourceId })).rejects.toBeInstanceOf(MediaValidationError);
  });

  it("probes downloaded media and reports blocked transcription when adapter missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "opening-parse-media-"));
    dirs.push(tempDir);
    const fileBytes = Buffer.alloc(64, 1);
    const states: string[] = [];
    const handler = createParseMediaHandler({
      sources: {
        get: async () => source({ bytes: fileBytes.byteLength }),
        markParseState: async (_s, _id, state) => {
          states.push(state);
          return source();
        },
      },
      chunks: { replaceChunks: async () => undefined },
      storage: {
        finalKey: () => "k",
        presignGet: async () => `data:video/mp4;base64,${fileBytes.toString("base64")}`,
      },
      tempDir,
      media: createMediaProcess({
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            format: { duration: "3", size: String(fileBytes.byteLength), format_name: "mp4" },
            streams: [{ codec_type: "video", width: 8, height: 8 }, { codec_type: "audio" }],
          }),
          stderr: "",
        }),
      }),
    });
    const result = await handler(job, { sourceId });
    expect(result).toMatchObject({
      ok: false,
      transcription: "blocked_not_configured",
      hasAudio: true,
      hasVideo: true,
    });
    expect(result).not.toHaveProperty("claimsVisualUnderstanding");
    expect(states).toEqual(["failed"]);
    expect(await readdir(tempDir)).toEqual([]);
  });

  it("persists transcribed segments when adapter returns validated timing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "opening-parse-media-"));
    dirs.push(tempDir);
    const fileBytes = Buffer.alloc(32, 2);
    let replaceInput: unknown;
    const handler = createParseMediaHandler({
      sources: {
        get: async () => source({ bytes: fileBytes.byteLength }),
        markParseState: async () => source(),
      },
      chunks: {
        replaceChunks: async (_s, input) => {
          replaceInput = input;
        },
      },
      storage: {
        finalKey: () => "k",
        presignGet: async () => `data:video/mp4;base64,${fileBytes.toString("base64")}`,
      },
      tempDir,
      media: createMediaProcess({
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            format: { duration: "2", size: String(fileBytes.byteLength), format_name: "mp4" },
            streams: [{ codec_type: "video", width: 8, height: 8 }, { codec_type: "audio" }],
          }),
          stderr: "",
        }),
      }),
      transcribe: async () => [
        {
          sourceId,
          sourceVersion: 1,
          startMs: 0,
          endMs: 1500,
          text: "课程开始",
          frameChunkIds: [],
          quality: "needs_check",
        },
      ],
    });
    const result = await handler(job, { sourceId });
    expect(result).toMatchObject({ ok: true, transcription: "completed", segmentCount: 1, claimsVisualUnderstanding: false });
    expect(replaceInput).toEqual({
      sourceId,
      sourceVersion: 1,
      chunks: [
        {
          page: 1,
          slideLabel: null,
          startMs: 0,
          endMs: 1500,
          text: "课程开始",
          imageObjectKey: null,
        },
      ],
    });
    expect(await readdir(tempDir)).toEqual([]);
  });

  it("persists keyframe chunks via I02 imageObjectKey linked by timestamp", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "opening-parse-media-"));
    dirs.push(tempDir);
    const fileBytes = Buffer.alloc(32, 3);
    let replaceInput: unknown;
    const putKeys: string[] = [];
    const frameDirPlaceholder = "will-be-set-by-extract";
    const handler = createParseMediaHandler({
      sources: {
        get: async () => source({ bytes: fileBytes.byteLength }),
        markParseState: async () => source(),
      },
      chunks: {
        replaceChunks: async (_s, input) => {
          replaceInput = input;
        },
      },
      storage: {
        finalKey: () => "k",
        presignGet: async () => `data:video/mp4;base64,${fileBytes.toString("base64")}`,
      },
      tempDir,
      media: createMediaProcess({
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            format: { duration: "5", size: String(fileBytes.byteLength), format_name: "mp4" },
            streams: [{ codec_type: "video", width: 8, height: 8 }, { codec_type: "audio" }],
          }),
          stderr: "",
        }),
      }),
      transcribe: async () => [
        {
          sourceId,
          sourceVersion: 1,
          startMs: 0,
          endMs: 3000,
          text: "第一段",
          frameChunkIds: [],
          quality: "needs_check",
        },
      ],
      extractFrames: async ({ outputDir }) => {
        const { writeFile, mkdir } = await import("node:fs/promises");
        await mkdir(outputDir, { recursive: true });
        const framePath = path.join(outputDir, "frame-0001.png");
        await writeFile(framePath, Buffer.from("fakepng"));
        return {
          frames: [{ path: framePath, timestampMs: 1200 }],
          visualCoverageLimited: false,
        };
      },
      putObject: async ({ key, body, mime }) => {
        putKeys.push(key);
        expect(mime).toBe("image/png");
        expect(body.byteLength).toBeGreaterThan(0);
      },
    });
    const result = await handler(job, { sourceId });
    expect(result).toMatchObject({
      ok: true,
      transcription: "completed",
      segmentCount: 1,
      frameCount: 1,
      claimsVisualUnderstanding: false,
      visualCoverageLimited: false,
    });
    expect(putKeys).toEqual([
      `opening/sources/${sourceId}/v1/frames/1200.png`,
    ]);
    expect(replaceInput).toEqual({
      sourceId,
      sourceVersion: 1,
      chunks: [
        {
          page: 1,
          slideLabel: null,
          startMs: 0,
          endMs: 3000,
          text: "第一段",
          imageObjectKey: null,
        },
        {
          page: 2,
          slideLabel: null,
          startMs: 1200,
          endMs: 1201,
          text: "[keyframe @ 1200ms]",
          imageObjectKey: `opening/sources/${sourceId}/v1/frames/1200.png`,
        },
      ],
    });
    expect(await readdir(tempDir)).toEqual([]);
  });

  it("treats missing whisper as blocked_not_configured without claiming visual understanding", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "opening-parse-media-"));
    dirs.push(tempDir);
    const fileBytes = Buffer.alloc(16, 4);
    const { MediaConfigurationError } = await import("../parsers/media-process");
    const handler = createParseMediaHandler({
      sources: {
        get: async () => source({ bytes: fileBytes.byteLength, mime: "audio/mpeg" }),
        markParseState: async (_s, _id, state) => source({ mime: "audio/mpeg", parseState: state as never }),
      },
      chunks: { replaceChunks: async () => undefined },
      storage: {
        finalKey: () => "k",
        presignGet: async () => `data:audio/mpeg;base64,${fileBytes.toString("base64")}`,
      },
      tempDir,
      media: createMediaProcess({
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            format: { duration: "1", size: String(fileBytes.byteLength), format_name: "mp3" },
            streams: [{ codec_type: "audio" }],
          }),
          stderr: "",
        }),
      }),
      transcribe: async () => {
        throw new MediaConfigurationError("faster-whisper is not installed");
      },
    });
    const result = await handler(job, { sourceId });
    expect(result).toMatchObject({
      ok: false,
      transcription: "blocked_not_configured",
      hasAudio: true,
      hasVideo: false,
    });
    expect(result).not.toHaveProperty("claimsVisualUnderstanding");
    expect(await readdir(tempDir)).toEqual([]);
  });

  it("skips re-transcription for segments-correction receipt payloads", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "opening-parse-media-"));
    dirs.push(tempDir);
    const handler = createParseMediaHandler({
      sources: {
        get: async () => {
          throw new Error("should not load source");
        },
        markParseState: async () => {
          throw new Error("should not mark");
        },
      },
      chunks: {
        replaceChunks: async () => {
          throw new Error("should not replace chunks");
        },
      },
      storage: {
        finalKey: () => "k",
        presignGet: async () => {
          throw new Error("should not download");
        },
      },
      tempDir,
    });
    const result = await handler(job, {
      sourceId,
      mode: "segments-correction",
      correctedVersion: 4,
      segmentCount: 2,
    });
    expect(result).toEqual({
      ok: true,
      mode: "segments-correction",
      sourceId,
      correctedVersion: 4,
      segmentCount: 2,
      claimsVisualUnderstanding: false,
      skipped: true,
    });
    expect(await readdir(tempDir)).toEqual([]);
  });

});
