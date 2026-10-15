import { mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModelForTask } from "@aistudy/ai";
import { DEFAULT_OPENING_AI_SETTINGS } from "@aistudy/contracts";
import { createModelTranscribeAdapter } from "./model-transcribe-adapter";
import { MediaValidationError } from "./media-process";

const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const input = { path: "/tmp/local.mp4", mime: "video/mp4", durationMs: 301_000, hasAudio: true,
  sourceId: "11111111-1111-4111-8111-111111111111", sourceVersion: 2 };
const signal = new AbortController().signal;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function setup(texts = [JSON.stringify({ segments: [{ startMs: 0, endMs: 900, text: "  first  " }] })]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-transcribe-test-"));
  dirs.push(dir);
  const run = vi.fn(async (_binary, argv: string[]) => {
    await writeFile(argv.at(-1)!, "RIFF-audio");
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const call = vi.fn(async () => ({ text: texts.shift()!, citedChunkIds: [], requestId: null, candidates: [] }));
  const beforeSend = vi.fn(async () => undefined);
  const adapter = createModelTranscribeAdapter({ gateway: { call }, scope, budget: {} as never, jobId: "job-id", run, tempDir: dir, beforeSend });
  return { dir, run, call, beforeSend, adapter };
}

describe("model transcription adapter", () => {
  it("uses bounded local WAV chunks, offsets their times, and uses durable per-job operation ids", async () => {
    const s = await setup([
      JSON.stringify({ segments: [{ startMs: 100, endMs: 500, text: "first" }] }),
      JSON.stringify({ segments: [{ startMs: 0, endMs: 900, text: "second" }] }),
    ]);
    const segments = await s.adapter(input, signal);
    expect(segments).toEqual([
      { sourceId: input.sourceId, sourceVersion: 2, startMs: 100, endMs: 500, text: "first", frameChunkIds: [], quality: "needs_check" },
      { sourceId: input.sourceId, sourceVersion: 2, startMs: 300_000, endMs: 300_900, text: "second", frameChunkIds: [], quality: "needs_check" },
    ]);
    expect(s.run.mock.calls[0]![1]).toEqual(expect.arrayContaining(["-ss", "0", "-t", "300", "-c:a", "pcm_s16le", "-ar", "16000"]));
    expect(s.run.mock.calls[1]![1]).toEqual(expect.arrayContaining(["-ss", "300", "-t", "1"]));
    expect(s.call.mock.calls.map(call => call[2].operationId)).toEqual(["transcribe:job-id:0", "transcribe:job-id:1"]);
    expect(s.call.mock.calls[0]).toEqual([scope, "media.transcribe", expect.objectContaining({
      beforeSend: s.beforeSend,
      input: expect.objectContaining({ outputFormat: "json", audioParts: [{ data: Buffer.from("RIFF-audio").toString("base64"), format: "wav" }] }),
    })]);
    expect(await readdir(s.dir)).toEqual([]);
  });

  it.each([
    "not json",
    JSON.stringify({ segments: {} }),
    JSON.stringify({ segments: [{ startMs: -1, endMs: 2, text: "negative" }] }),
    JSON.stringify({ segments: [{ startMs: 0, endMs: 2, text: "   " }] }),
    JSON.stringify({ segments: [{ startMs: 0, endMs: 1001, text: "outside chunk" }] }),
    JSON.stringify({ segments: [{ startMs: 0, endMs: 20, text: "one" }, { startMs: 10, endMs: 30, text: "overlap" }] }),
  ])("rejects invalid untrusted transcription and cleans local chunks (%s)", async (text) => {
    const s = await setup([text]);
    await expect(s.adapter({ ...input, durationMs: 1000 }, signal)).rejects.toBeInstanceOf(MediaValidationError);
    expect(s.call).toHaveBeenCalledTimes(1);
    expect(await readdir(s.dir)).toEqual([]);
  });

  it("checks privacy before audio conversion and passes the same fence to the gateway", async () => {
    const s = await setup();
    s.beforeSend.mockRejectedValue(new Error("privacy changed"));
    await expect(s.adapter(input, signal)).rejects.toThrow("privacy changed");
    expect(s.run).not.toHaveBeenCalled();
    expect(s.call).not.toHaveBeenCalled();
    expect(await readdir(s.dir)).toEqual([]);
  });

  it("does not retry an unknown gateway result", async () => {
    const s = await setup();
    s.call.mockRejectedValue(new Error("outcome unknown"));
    await expect(s.adapter(input, signal)).rejects.toThrow("outcome unknown");
    expect(s.call).toHaveBeenCalledTimes(1);
    expect(await readdir(s.dir)).toEqual([]);
  });

  it("keeps every chunk of a long recording under the 20 MB inline request limit", async () => {
    // 20 minutes of 16 kHz 16-bit mono: 32 000 bytes per second of real WAV payload.
    const s = await setup(Array.from({ length: 4 }, () => JSON.stringify({ segments: [] })));
    s.run.mockImplementation(async (_binary, argv: string[]) => {
      const seconds = Number(argv[argv.indexOf("-t") + 1]);
      await writeFile(argv.at(-1)!, "");
      await truncate(argv.at(-1)!, 44 + seconds * 32_000);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await s.adapter({ ...input, durationMs: 1_200_000 }, signal);
    expect(s.call).toHaveBeenCalledTimes(4);
    for (const [, , options] of s.call.mock.calls as unknown as Array<[unknown, unknown, { input: { audioParts: Array<{ data: string }>; instruction: string; text: string } }]>) {
      const bytes = options.input.audioParts[0]!.data.length + options.input.instruction.length + options.input.text.length;
      expect(bytes).toBeLessThan(18 * 1024 * 1024);
    }
  });

  it("rejects oversized conversion before sending audio", async () => {
    const s = await setup();
    s.run.mockImplementation(async (_binary, argv) => {
      await writeFile(argv.at(-1)!, "");
      await truncate(argv.at(-1)!, 20 * 1024 * 1024 + 1);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await expect(s.adapter(input, signal)).rejects.toThrow("chunk size");
    expect(s.call).not.toHaveBeenCalled();
    expect(await readdir(s.dir)).toEqual([]);
  });

  it("does not convert silent media", async () => {
    const s = await setup();
    await expect(s.adapter({ ...input, hasAudio: false }, signal)).resolves.toEqual([]);
    expect(s.run).not.toHaveBeenCalled();
    expect(s.call).not.toHaveBeenCalled();
  });

  it("requires an audio-capable model for the registered transcription task", () => {
    expect(() => resolveModelForTask([{
      id: "text", providerId: "provider", modelName: "text", label: "Text", providerLabel: "Provider",
      inputCentsPerMillion: 1, outputCentsPerMillion: 1, availability: "available", supportsAudio: false,
    }], DEFAULT_OPENING_AI_SETTINGS, "media.transcribe", "text")).toThrow("不支持音频输入");
  });
});
