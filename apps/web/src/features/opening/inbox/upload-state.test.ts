import { expect, it } from "vitest";
import { resolveUploadMime, sourceStatusLabel } from "./upload-state";

it("distinguishes stored originals from parsed material", () => {
  expect(sourceStatusLabel({ uploadState: "uploaded", parseState: "failed" })).toBe("原件已保存，解析失败");
  expect(sourceStatusLabel({ uploadState: "pending", parseState: "not_started" })).toBe("等待上传完成");
  expect(sourceStatusLabel({ uploadState: "uploaded", parseState: "ready" })).toBe("可以用于提问");
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
  expect(resolveUploadMime({ name: "a.bin", type: "application/octet-stream" })).toBeNull();
});
