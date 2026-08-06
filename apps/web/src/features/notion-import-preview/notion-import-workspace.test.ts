// Vitest's workspace glob currently includes only *.test.ts, so this component
// test intentionally uses that extension while rendering TSX through Vite.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// Workspace chrome is intentionally tested as static markup: state lives in the import container.
import { NotionImportWorkspace } from "./notion-import-workspace";

const props = {
  children: createElement("article", null, "导入预览正文"),
  documentTitle: "概率推理笔记",
  pageCount: 3,
  selectedPageTitle: "概率推理笔记",
  onClosePanel: () => undefined,
  onOpenPage: () => undefined,
  onReset: () => undefined,
  onToggleFullWidth: () => undefined,
  onTogglePanel: () => undefined,
  onToggleSidebar: () => undefined,
  panel: null,
  sidebarOpen: true,
  textStyle: "default" as const,
  fullWidth: false,
  onTextStyleChange: () => undefined,
};

describe("notion import workspace", () => {
  it("renders workspace navigation and keeps the page canvas central", () => {
    const html = renderToStaticMarkup(createElement(NotionImportWorkspace, props));

    expect(html).toContain('aria-label="工作区导航"');
    expect(html).toContain("sm:flex");
    expect(html).toContain("Private");
    expect(html).toContain("概率推理笔记");
    expect(html).toContain("导入预览正文");
    expect(html).toContain('aria-label="切换侧边栏"');
    expect(html).toContain('aria-label="更多页面操作"');
    expect(html).toContain('aria-label="分享当前导入预览"');
  });

  it("renders the Notion-style action menu with page appearance controls", () => {
    const html = renderToStaticMarkup(createElement(NotionImportWorkspace, { ...props, panel: "actions" as const }));

    expect(html).toContain("Search actions...");
    expect(html).toContain("Default");
    expect(html).toContain("Serif");
    expect(html).toContain("Mono");
    expect(html).toContain("Small text");
    expect(html).toContain("Full width");
    expect(html).toContain("Import another export");
    expect(html).toContain("Export report");
  });

  it("renders a compact share panel on demand", () => {
    const html = renderToStaticMarkup(createElement(NotionImportWorkspace, { ...props, panel: "share" as const }));

    expect(html).toContain("Share import preview");
    expect(html).toContain("Keep source private");
  });
});
