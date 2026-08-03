import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentLoadError } from "./document-editor";

describe("document editor recovery", () => {
  it("exposes a retry action when the document cannot load", () => {
    const html = renderToStaticMarkup(createElement(DocumentLoadError, {
      message: "暂时无法读取这篇笔记，请稍后重试。",
      onRetry: () => undefined,
    }));

    expect(html).toContain('role="alert"');
    expect(html).toContain("重试");
  });
});
