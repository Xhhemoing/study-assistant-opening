import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { ErrorState } from "./error-state";
import { Card, Drawer, EmptyState, Field, StatusBadge } from "./primitives";

describe("shared UI primitives", () => {
  it("renders status words with an icon and accessible label", () => {
    const html = renderToStaticMarkup(createElement(StatusBadge, { status: "weak" }));
    expect(html).toContain("薄弱");
    expect(html).toContain('aria-label="状态：薄弱"');
    expect(html).toContain("svg");
    expect(html).toContain("bg-warn-soft");
  });

  it("does not expose closed portal content during server rendering", () => {
    expect(renderToStaticMarkup(createElement(Drawer, { open: false, onClose: () => undefined }, "内容"))).toBe("");
  });

  it("provides reusable card, empty, and field structure", () => {
    const html = renderToStaticMarkup(createElement(
      "section",
      null,
      createElement(Card, { as: "article" }, "内容"),
      createElement(EmptyState, { title: "没有结果", description: "换一个关键词" }),
      createElement(Field, { label: "标题", htmlFor: "title", error: "标题不能为空" }, createElement("input", { id: "title" })),
    ));
    expect(html).toContain("内容");
    expect(html).toContain("没有结果");
    expect(html).toContain('for="title"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("标题不能为空");
  });
});


describe("form and error primitives", () => {
  it("links a direct field to its description and error without losing existing help", () => {
    const html = renderToStaticMarkup(createElement(Field, { label: "标题", htmlFor: "title", description: "写一句话", error: "还没有填写标题" }, createElement("input", { id: "title", "aria-describedby": "existing-help" })));
    expect(html).toContain('aria-describedby="existing-help title-description title-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('id="title-description"');
    expect(html).toContain('id="title-error"');
  });

  it("defaults buttons to non-submit and keeps explicit submit/disabled semantics", () => {
    const html = renderToStaticMarkup(createElement("form", null, createElement(Button, null, "返回"), createElement(Button, { type: "submit", disabled: true }, "提交")));
    expect(html).toContain('type="button"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('disabled=""');
  });

  it("only offers retry when a retry action is available", () => {
    const withoutRetry = renderToStaticMarkup(createElement(ErrorState, { message: "没能保存这次作答" }));
    expect(withoutRetry).toContain('role="alert"');
    expect(withoutRetry).not.toContain("button");
    const retry = renderToStaticMarkup(createElement(ErrorState, { message: "没能保存这次作答", onRetry: () => undefined, retryLabel: "重试保存" }));
    expect(retry).toContain("重试保存");
  });
});
