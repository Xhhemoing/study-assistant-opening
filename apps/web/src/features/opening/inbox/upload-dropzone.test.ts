import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UploadDropzone, isAcceptedUploadFile, openingUploadAccept, supportedUploadTypesLabel } from "./upload-dropzone";

describe("UploadDropzone", () => {
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
});
