import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Card, Drawer, EmptyState, Field, StatusBadge } from "./primitives";

describe("shared UI primitives", () => {
  it("renders status words with an icon and accessible label", () => {
    const html = renderToStaticMarkup(createElement(StatusBadge, { status: "weak" }));
    expect(html).toContain("薄弱");
    expect(html).toContain('aria-label="状态：薄弱"');
    expect(html).toContain("svg");
    expect(html).toContain("bg-warning");
  });

  it("renders a closed drawer as nothing and an open drawer as a modal", () => {
    expect(renderToStaticMarkup(createElement(Drawer, { open: false, onClose: () => undefined }, "内容"))).toBe("");
    const html = renderToStaticMarkup(createElement(Drawer, { open: true, onClose: () => undefined, title: "详情" }, "内容"));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-drawer-backdrop="true"');
    expect(html).toContain("详情");
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
