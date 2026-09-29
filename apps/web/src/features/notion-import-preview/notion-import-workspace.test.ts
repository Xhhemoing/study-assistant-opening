import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NotionImportWorkspace } from "./notion-import-workspace";

const props = {
  children: createElement("article", null, "导入预览正文"),
  documentTitle: "概率推理笔记",
  pages: [{ id: "page-1", title: "概率推理笔记", path: "概率推理笔记.html" }, { id: "page-2", title: "诊断测试的例子", path: "诊断测试的例子.html" }],
  selectedPageId: "page-1",
  onClosePanel: () => undefined,
  onOpenPage: () => undefined,
  onReset: () => undefined,
  onExportReport: () => undefined,
  onTextStyleChange: () => undefined,
  onToggleFullWidth: () => undefined,
  onTogglePanel: () => undefined,
  onToggleSidebar: () => undefined,
  panel: null,
  sidebarOpen: true,
  textStyle: "default" as const,
  fullWidth: false,
};

describe("notion import workspace", () => {
  it("renders parsed page navigation and a compact reading canvas", () => {
    const html = renderToStaticMarkup(createElement(NotionImportWorkspace, props));
    expect(html).toContain('aria-label="导入页面导航"');
    expect(html).toContain("导入页面");
    expect(html).toContain("概率推理笔记");
    expect(html).toContain("诊断测试的例子");
    expect(html).toContain("导入预览正文");
    expect(html).toContain('aria-label="切换页面列表"');
    expect(html).toContain("未上传或保存到知识库");
  });

  it("renders local appearance controls in the context inspector", () => {
    const html = renderToStaticMarkup(createElement(NotionImportWorkspace, { ...props, panel: "actions" as const }));
    expect(html).toContain("阅读字体");
    expect(html).toContain("下载格式损失报告");
    expect(html).toContain("重新选择 ZIP");
    expect(html).toContain("宽版阅读");
  });

  it("states that sharing is unavailable in the local preview", () => {
    const html = renderToStaticMarkup(createElement(NotionImportWorkspace, { ...props, panel: "share" as const }));
    expect(html).toContain("尚未接入发布、分享链接或存入知识库");
    expect(html).toContain("分享尚不可用");
  });
});
