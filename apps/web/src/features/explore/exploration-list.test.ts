import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExplorationLoadError } from "./exploration-list";

describe("exploration list recovery", () => {
  it("exposes a retry action for a failed list load", () => {
    const html = renderToStaticMarkup(createElement(ExplorationLoadError, {
      message: "探索列表加载失败，请重试。",
      onRetry: () => undefined,
    }));

    expect(html).toContain('role="alert"');
    expect(html).toContain("探索列表加载失败，请重试。");
    expect(html).toContain("重试");
  });
});
