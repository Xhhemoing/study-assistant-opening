import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UploadDropzone, isAcceptedUploadFile, supportedUploadTypesLabel } from "./upload-dropzone";

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
});
