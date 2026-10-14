import { expect, it } from "vitest";
import { canDeleteSourceShortcut, isAgedQueuedParse, resolveUploadMime, sourceHasUsableChunksForQuestions, sourceStatusLabel, unsupportedUploadMessage } from "./upload-state";

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

it("accepts mp4/webm video by extension and declared MIME", () => {
  expect(resolveUploadMime({ name: "clip.mp4", type: "" })).toBe("video/mp4");
  expect(resolveUploadMime({ name: "clip.webm", type: "video/webm" })).toBe("video/webm");
});

it("exposes aged-queued and delete-shortcut helpers", () => {
  const now = Date.parse("2026-10-10T14:00:00.000Z");
  expect(isAgedQueuedParse({ uploadState: "uploaded", parseState: "queued", createdAt: "2026-10-10T13:56:00.000Z" }, now)).toBe(true);
  expect(isAgedQueuedParse({ uploadState: "uploaded", parseState: "queued", createdAt: "2026-10-10T13:58:00.000Z" }, now)).toBe(false);
  expect(isAgedQueuedParse({ uploadState: "uploaded", parseState: "running", createdAt: "2026-10-10T13:50:00.000Z" }, now)).toBe(false);
  expect(canDeleteSourceShortcut({ uploadState: "uploaded", parseState: "unsupported" }, now)).toBe(true);
  expect(canDeleteSourceShortcut({ uploadState: "uploaded", parseState: "queued", createdAt: "2026-10-10T13:56:00.000Z" }, now)).toBe(true);
  expect(canDeleteSourceShortcut({ uploadState: "uploaded", parseState: "ready" }, now)).toBe(false);
});

it("accepts .txt as text/plain and still rejects unknown declared MIME (S9)", () => {
  expect(resolveUploadMime({ name: "notes.txt", type: "" })).toBe("text/plain");
  expect(resolveUploadMime({ name: "notes.txt", type: "text/plain" })).toBe("text/plain");
  expect(resolveUploadMime({ name: "notes.txt", type: "application/x-unknown" })).toBeNull();
});

it("three layers agree on text/plain (S9)", async () => {
  const { sourceMimeSchema } = await import("@aistudy/contracts");
  const { openingUploadAccept, isAcceptedUploadFile } = await import("./upload-dropzone");
  const mime = resolveUploadMime({ name: "a.txt", type: "text/plain" });
  expect(mime).toBe("text/plain");
  expect(sourceMimeSchema.safeParse(mime).success).toBe(true);
  expect(isAcceptedUploadFile({ name: "a.txt", type: "text/plain" } as File, openingUploadAccept)).toBe(true);
  expect(sourceMimeSchema.safeParse("application/x-unknown").success).toBe(false);
  expect(resolveUploadMime({ name: "a.bin", type: "application/x-unknown" })).toBeNull();
});

it("maps upload/parse states to status copy (S10 table)", () => {
  const now = Date.parse("2026-10-14T12:00:00.000Z");
  expect(sourceStatusLabel({ uploadState: "uploaded", parseState: "ready" }, now)).toBe("可以用于提问");
  expect(sourceStatusLabel({ uploadState: "uploaded", parseState: "queued" }, now)).toBe("原件已保存，解析排队中");
  expect(sourceStatusLabel({ uploadState: "uploaded", parseState: "running" }, now)).toBe("原件已保存，正在解析");
  expect(sourceStatusLabel({ uploadState: "uploaded", parseState: "failed" }, now)).toBe("原件已保存，解析失败");
  expect(sourceStatusLabel({ uploadState: "uploaded", parseState: "unsupported" }, now)).toBe("原件已保存，暂不能提取文字");
  expect(sourceStatusLabel({ uploadState: "pending", parseState: "not_started" }, now)).toBe("上传未完成");
});

it("「可以用于提问」 shares the chunks-usable predicate (S10)", () => {
  expect(sourceHasUsableChunksForQuestions({ uploadState: "uploaded", parseState: "ready" })).toBe(true);
  expect(sourceStatusLabel({ uploadState: "uploaded", parseState: "ready" })).toBe("可以用于提问");

  // Chunks known present → usable even if parse copy would otherwise say 正在解析
  expect(
    sourceHasUsableChunksForQuestions({
      uploadState: "uploaded",
      parseState: "running",
      hasChunks: true,
    }),
  ).toBe(true);
  expect(
    sourceStatusLabel({ uploadState: "uploaded", parseState: "running", hasChunks: true }),
  ).toBe("可以用于提问");

  // Chunks known absent → never claim 可以用于提问 even if parseState ready
  expect(
    sourceHasUsableChunksForQuestions({
      uploadState: "uploaded",
      parseState: "ready",
      hasChunks: false,
    }),
  ).toBe(false);
  expect(
    sourceStatusLabel({ uploadState: "uploaded", parseState: "ready", hasChunks: false }),
  ).not.toBe("可以用于提问");

  // Label 可以用于提问 ⇒ predicate true (same function, not a copied condition)
  const usable = { uploadState: "uploaded" as const, parseState: "ready" as const, hasChunks: true };
  expect(sourceStatusLabel(usable)).toBe("可以用于提问");
  expect(sourceHasUsableChunksForQuestions(usable)).toBe(true);
});
