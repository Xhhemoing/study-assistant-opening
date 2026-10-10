import { expect, it } from "vitest";
import { resolveUploadMime, sourceStatusLabel, unsupportedUploadMessage } from "./upload-state";

it("distinguishes stored originals from parsed material", () => {
  expect(sourceStatusLabel({ uploadState: "uploaded", parseState: "failed" })).toBe("原件已保存，解析失败");
  expect(sourceStatusLabel({ uploadState: "pending", parseState: "not_started" })).toBe("上传未完成");
  expect(sourceStatusLabel({ uploadState: "uploaded", parseState: "ready" })).toBe("可以用于提问");
});

it("accepts audio files without renaming them to another type", () => {
  expect(resolveUploadMime({ name: "lecture.mp3", type: "audio/mpeg" })).toBe("audio/mpeg");
  expect(resolveUploadMime({ name: "lecture.m4a", type: "" })).toBe("audio/mp4");
  expect(resolveUploadMime({ name: "lecture.wav", type: "audio/wav" })).toBe("audio/wav");
});

it("rejects unknown and legacy powerpoint without renaming them to pdf", () => {
  expect(resolveUploadMime({ name: "notes.md", type: "" })).toBe("text/markdown");
  expect(resolveUploadMime({ name: "notes.markdown", type: "text/markdown" })).toBe("text/markdown");
  expect(resolveUploadMime({ name: "notes.html", type: "" })).toBe("text/html");
  expect(resolveUploadMime({ name: "deck.ppt", type: "" })).toBe("application/vnd.ms-powerpoint");
  expect(sourceStatusLabel({ uploadState: "uploaded", parseState: "unsupported" })).toBe("原件已保存，暂不能提取文字");
  expect(resolveUploadMime({ name: "photo.heic", type: "" })).toBeNull();
  expect(resolveUploadMime({ name: "slides.pptx", type: "" })).toBe(
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  expect(resolveUploadMime({ name: "lesson.eml", type: "" })).toBe("message/rfc822");
  expect(resolveUploadMime({ name: "lesson.eml", type: "message/rfc822" })).toBe("message/rfc822");
  expect(resolveUploadMime({ name: "a.bin", type: "application/octet-stream" })).toBeNull();
});

it("does not use an extension when a declared unsupported MIME is present", () => {
  expect(resolveUploadMime({ name: "renamed.pdf", type: "application/octet-stream" })).toBeNull();
});

it("tells HEIC uploaders to export JPG instead of decoding", () => {
  expect(unsupportedUploadMessage({ name: "photo.heic", type: "" })).toBe("请导出为 JPG 后上传");
  expect(unsupportedUploadMessage({ name: "photo.HEIF", type: "image/heif" })).toBe("请导出为 JPG 后上传");
  expect(unsupportedUploadMessage({ name: "a.bin", type: "application/octet-stream" })).toBe("不支持这个格式，未改名也未创建材料。");
});

it("resolves webp by extension when MIME is empty", () => {
  expect(resolveUploadMime({ name: "shot.webp", type: "" })).toBe("image/webp");
});

it("shows blocked_not_configured message on failed, keeps generic failed fallback, and prioritizes PRIVACY", () => {
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
  expect(sourceStatusLabel({ uploadState: "uploaded", parseState: "failed" })).toBe("原件已保存，解析失败");
  expect(
    sourceStatusLabel({
      uploadState: "uploaded",
      parseState: "failed",
      error: { code: "PRIVACY_EXCLUDED", message: "隐私排除", retryable: false },
    }),
  ).toBe("已从学习上下文中排除");
});

it("differentiates running from queued and aged queued without fake-fail", () => {
  const now = Date.parse("2026-10-10T14:00:00.000Z");
  expect(sourceStatusLabel({ uploadState: "uploaded", parseState: "running" }, now)).toBe("原件已保存，正在解析");
  expect(sourceStatusLabel({ uploadState: "uploaded", parseState: "queued" }, now)).toBe("原件已保存，解析排队中");
  expect(sourceStatusLabel({ uploadState: "uploaded", parseState: "not_started" }, now)).toBe("原件已保存，解析排队中");
  expect(
    sourceStatusLabel(
      { uploadState: "uploaded", parseState: "queued", createdAt: "2026-10-10T13:56:00.000Z" },
      now,
    ),
  ).toBe("原件已保存，解析排队中，可能较慢");
  // Fresh createdAt stays non-aged
  expect(
    sourceStatusLabel(
      { uploadState: "uploaded", parseState: "queued", createdAt: "2026-10-10T13:58:00.000Z" },
      now,
    ),
  ).toBe("原件已保存，解析排队中");
});
