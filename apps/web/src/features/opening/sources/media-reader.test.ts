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
        source: { ...baseSource, parseState: "unsupported" },
        segments: [],
      }),
    ).toBe("parse_unsupported_original_saved");

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

    expect(mediaReaderStateCopy("parse_failed_original_saved")).toBe("原件已保存，解析失败");
    expect(mediaReaderStateCopy("parse_unsupported_original_saved")).toBe("原件已保存，暂不能提取文字");
    expect(mediaReaderStateCopy("audio_only_transcript")).toContain("仅音频");
    expect(mediaReaderStateCopy("insufficient_visual_coverage")).toContain("视觉覆盖不足");
  });

  it("marks unavailable services without sample content copy", () => {
    expect(classifyMediaReaderState({ source: null, segments: null, unavailable: true })).toBe("unavailable");
    expect(mediaReaderStateCopy("unavailable")).toMatch(/不可用/);
  });
});

it("surfaces blocked_not_configured via sourceStatusLabel for failed media", async () => {
  const { sourceStatusLabel } = await import("../inbox/upload-state");
  expect(
    sourceStatusLabel({
      uploadState: "uploaded",
      parseState: "failed",
      error: {
        code: "blocked_not_configured",
        message: "转写服务未配置（需 faster-whisper），原件已保存；配置完成前重试无效。",
        retryable: false,
      },
    }),
  ).toContain("转写服务未配置");
});
