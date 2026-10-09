import { describe, expect, it } from "vitest";
import { classifyMediaReaderState, mediaReaderStateCopy } from "./media-reader";

const baseSource = {
  mime: "video/mp4" as const,
  parseState: "ready" as const,
  uploadState: "uploaded" as const,
};

describe("media-reader state", () => {
  it("distinguishes parse-failed, audio-only, and insufficient visual coverage", () => {
    expect(
      classifyMediaReaderState({
        source: { ...baseSource, parseState: "failed" },
        segments: [],
      }),
    ).toBe("parse_failed_original_saved");

    expect(
      classifyMediaReaderState({
        source: { ...baseSource, mime: "audio/mpeg" },
        segments: [
          {
            sourceId: "00000000-0000-4000-8000-000000000001",
            sourceVersion: 1,
            startMs: 0,
            endMs: 1000,
            text: "hi",
            frameChunkIds: [],
            quality: "needs_check",
          },
        ],
      }),
    ).toBe("audio_only_transcript");

    expect(
      classifyMediaReaderState({
        source: baseSource,
        segments: [
          {
            sourceId: "00000000-0000-4000-8000-000000000001",
            sourceVersion: 1,
            startMs: 0,
            endMs: 1000,
            text: "hi",
            frameChunkIds: [],
            quality: "needs_check",
          },
        ],
      }),
    ).toBe("insufficient_visual_coverage");

    expect(mediaReaderStateCopy("parse_failed_original_saved")).toContain("原件已保存");
    expect(mediaReaderStateCopy("audio_only_transcript")).toContain("仅音频");
    expect(mediaReaderStateCopy("insufficient_visual_coverage")).toContain("视觉覆盖不足");
  });

  it("marks unavailable services without sample content copy", () => {
    expect(classifyMediaReaderState({ source: null, segments: null, unavailable: true })).toBe("unavailable");
    expect(mediaReaderStateCopy("unavailable")).toMatch(/不可用/);
  });
});
