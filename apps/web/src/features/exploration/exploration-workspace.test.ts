import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExplorationWorkspaceDetail, ExplorationWorkspaceList } from "./exploration-workspace";

describe("persisted exploration workspace", () => {
  it("keeps creation available while the exploration list is loading", () => {
    const html = renderToStaticMarkup(createElement(ExplorationWorkspaceList));
    expect(html).toContain("自由探索");
    expect(html).toContain('aria-label="开始探索"');
    expect(html).toContain("正在加载探索");
    expect(html).not.toContain("还没有探索");
  });

  it("does not expose editable branch content before the detail has loaded", () => {
    const html = renderToStaticMarkup(createElement(ExplorationWorkspaceDetail, { explorationId: "exploration-1" }));
    expect(html).toContain("正在加载探索");
    expect(html).not.toContain('id="block-content"');
  });
});
