import { describe, expect, it } from "vitest";
import { createPythonTranscribeAdapter } from "./transcribe-adapter";
import { MediaConfigurationError } from "./media-process";

describe("createPythonTranscribeAdapter", () => {
  it("maps CONFIGURATION JSON / exit 2 to MediaConfigurationError", async () => {
    const adapt = createPythonTranscribeAdapter({
      run: async () => ({
        exitCode: 2,
        stdout: JSON.stringify({
          ok: false,
          code: "CONFIGURATION",
          error: "faster-whisper is not installed",
        }),
        stderr: "",
      }),
      workDir: "/tmp/opening-transcribe-test-unused",
    });
    await expect(
      adapt({ path: "/tmp/a.wav", mime: "audio/wav", durationMs: 1000, hasAudio: true }, new AbortController().signal),
    ).rejects.toBeInstanceOf(MediaConfigurationError);
  });

  it("maps blocked_not_configured payload to CONFIGURATION without inventing segments", async () => {
    const adapt = createPythonTranscribeAdapter({
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          transcription: "blocked_not_configured",
          code: "CONFIGURATION",
          transcriptionError: "model 'base' is not available offline",
          segments: [],
          frames: [],
        }),
        stderr: "",
      }),
      workDir: "/tmp/opening-transcribe-test-unused",
    });
    await expect(
      adapt({ path: "/tmp/a.mp4", mime: "video/mp4", durationMs: 2000, hasAudio: true }, new AbortController().signal),
    ).rejects.toThrow(/offline|CONFIGURATION|not available/i);
  });

  it("returns MediaSegment-shaped rows when process_media completes", async () => {
    const adapt = createPythonTranscribeAdapter({
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          transcription: "completed",
          segments: [{ startMs: 0, endMs: 800, text: "你好", language: "zh" }],
          frames: [],
        }),
        stderr: "",
      }),
      workDir: "/tmp/opening-transcribe-test-unused",
    });
    const segments = await adapt(
      {
        path: "/tmp/a.mp4",
        mime: "video/mp4",
        durationMs: 2000,
        hasAudio: true,
        sourceId: "11111111-1111-4111-8111-111111111111",
        sourceVersion: 2,
      },
      new AbortController().signal,
    );
    expect(segments).toEqual([
      {
        sourceId: "11111111-1111-4111-8111-111111111111",
        sourceVersion: 2,
        startMs: 0,
        endMs: 800,
        text: "你好",
        frameChunkIds: [],
        quality: "needs_check",
      },
    ]);
  });

  it("skips spawn when hasAudio is false", async () => {
    let called = false;
    const adapt = createPythonTranscribeAdapter({
      run: async () => {
        called = true;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });
    await expect(
      adapt({ path: "/tmp/a.mp4", mime: "video/mp4", durationMs: 1000, hasAudio: false }, new AbortController().signal),
    ).resolves.toEqual([]);
    expect(called).toBe(false);
  });
});
