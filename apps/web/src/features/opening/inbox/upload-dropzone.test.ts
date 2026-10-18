import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UploadDropzone, isAcceptedUploadFile, openingUploadAccept, supportedUploadTypesLabel, uploadFileRejection } from "./upload-dropzone";
import { CaptureDialog } from "./capture-dialog";

describe("UploadDropzone", () => {
  it("provides a compact add control with the same accessible picker and file restrictions", () => {
    const html = renderToStaticMarkup(createElement(CaptureDialog, {
      compact: true,
      onFiles: () => {},
    }));
    expect(html).toContain('aria-label="添加资料"');
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(`accept="${openingUploadAccept}"`);
    expect(html).toContain('capture="environment"');
    expect(html).toContain('multiple=""');
    expect(html).not.toContain("拖入文件到这里");
    expect(html).not.toContain("选择文件");
    expect(html).not.toContain("可一次添加多个文件");
  });

  it("renders a keyboard-accessible multi-file drop target", () => {
    const html = renderToStaticMarkup(createElement(UploadDropzone, {
      accept: ".pdf,.png,audio/*",
      multiple: true,
      onFiles: () => {},
    }));
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="上传材料"');
    expect(html).toContain("拖入文件到这里");
    expect(html).toContain("支持类型：PDF、PNG、AUDIO");
    expect(html).toContain('multiple=""');
    expect(html).toContain('accept=".pdf,.png,audio/*"');
  });

  it("shows a disabled state without inviting a new upload", () => {
    const html = renderToStaticMarkup(createElement(UploadDropzone, {
      disabled: true,
      onFiles: () => {},
    }));
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("当前正在上传");
    expect(html).toContain('disabled=""');
  });

  it("describes the concrete accepted types when a custom accept list is provided", () => {
    const html = renderToStaticMarkup(createElement(UploadDropzone, {
      accept: ".pdf,.png",
      onFiles: () => {},
    }));
    expect(html).toContain(`支持类型：${supportedUploadTypesLabel(".pdf,.png")}`);
  });

  it("rejects a declared MIME mismatch even when the filename looks supported", () => {
    expect(isAcceptedUploadFile({ name: "evil.pdf", type: "text/plain" } as File, ".pdf,.png")).toBe(false);
    expect(isAcceptedUploadFile({ name: "notes.pdf", type: "" } as File, ".pdf,.png")).toBe(true);
  });

  it("rejects legacy ppt and eml from the default accept list while keeping pptx and pdf", () => {
    expect(openingUploadAccept.split(",")).not.toContain(".ppt");
    expect(openingUploadAccept.split(",")).not.toContain(".eml");
    expect(openingUploadAccept.split(",")).toContain(".pptx");
    expect(openingUploadAccept.split(",")).toContain(".pdf");
    expect(supportedUploadTypesLabel(openingUploadAccept)).not.toMatch(/\bPPT\b/);
    expect(supportedUploadTypesLabel(openingUploadAccept)).not.toContain("EML");
    expect(supportedUploadTypesLabel(openingUploadAccept)).toContain("PPTX");
    expect(isAcceptedUploadFile({ name: "deck.ppt", type: "" } as File, openingUploadAccept)).toBe(false);
    expect(isAcceptedUploadFile({ name: "mail.eml", type: "" } as File, openingUploadAccept)).toBe(false);
    expect(isAcceptedUploadFile({ name: "deck.pptx", type: "" } as File, openingUploadAccept)).toBe(true);
    expect(isAcceptedUploadFile({ name: "notes.pdf", type: "" } as File, openingUploadAccept)).toBe(true);
    expect(isAcceptedUploadFile({ name: "lecture.mp3", type: "audio/mpeg" } as File, openingUploadAccept)).toBe(true);
  });

  it("accepts mp4/webm video on the default accept list", () => {
    expect(openingUploadAccept.split(",")).toContain(".mp4");
    expect(openingUploadAccept.split(",")).toContain(".webm");
    expect(isAcceptedUploadFile({ name: "clip.mp4", type: "" } as File, openingUploadAccept)).toBe(true);
    expect(isAcceptedUploadFile({ name: "clip.webm", type: "video/webm" } as File, openingUploadAccept)).toBe(true);
    expect(supportedUploadTypesLabel(openingUploadAccept)).toContain("MP4");
    expect(supportedUploadTypesLabel(openingUploadAccept)).toContain("WebM");
  });

  it("accepts .txt on the default accept list (S9)", () => {
    expect(openingUploadAccept.split(",")).toContain(".txt");
    expect(isAcceptedUploadFile({ name: "notes.txt", type: "" } as File, openingUploadAccept)).toBe(true);
    expect(isAcceptedUploadFile({ name: "notes.txt", type: "text/plain" } as File, openingUploadAccept)).toBe(true);
    expect(supportedUploadTypesLabel(openingUploadAccept)).toContain("TXT");
  });

  it.each([
    { name: "image.png", type: "image/png", limit: 20 * 1024 * 1024 },
    { name: "notes.pdf", type: "application/pdf", limit: 50 * 1024 * 1024 },
    { name: "lecture.mp3", type: "audio/mpeg", limit: 200 * 1024 * 1024 },
    { name: "lesson.mp4", type: "video/mp4", limit: 512 * 1024 * 1024 },
  ])("validates $name against the upload contract before reading its bytes", ({ name, type, limit }) => {
    const arrayBuffer = vi.fn();
    const file = { name, type, size: limit, arrayBuffer };
    expect(uploadFileRejection(file)).toBeNull();
    expect(uploadFileRejection({ ...file, size: limit + 1 })).toContain("超过此格式的大小限制");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects empty files and unusable names with a readable reason", () => {
    expect(uploadFileRejection({ name: "empty.txt", type: "text/plain", size: 0 })).toContain("为空");
    expect(uploadFileRejection({ name: "../notes.txt", type: "text/plain", size: 4 })).toContain("请重命名");
  });

});
