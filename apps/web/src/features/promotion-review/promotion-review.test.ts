import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PromotionReview } from "./promotion-review";

describe("promotion review", () => {
  it("shows a distinct loading state and the return path to its exploration", () => {
    const html = renderToStaticMarkup(createElement(PromotionReview, { explorationId: "exploration-1" }));
    expect(html).toContain("正在读取候选内容");
    expect(html).not.toContain("还没有候选内容");
    expect(html).toContain('href="/explore/exploration-1"');
  });

  it("preserves explicit candidate creation fields and does not offer acceptance before loading", () => {
    const html = renderToStaticMarkup(createElement(PromotionReview, { explorationId: "exploration-1" }));
    expect(html).toContain('aria-label="候选类型"');
    expect(html).toContain('aria-label="候选标题"');
    expect(html).toContain('aria-label="候选内容"');
    expect(html).toContain("创建候选");
    expect(html).not.toContain('aria-label="接受候选"');
  });
});
