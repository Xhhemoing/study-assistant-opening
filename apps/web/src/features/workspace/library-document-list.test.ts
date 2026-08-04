import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: unknown; href: string }) =>
    createElement("a", { ...props, href }, children),
}));

import { LibraryDocumentList } from "./library-document-list";

describe("library document list", () => {
  it("exposes an accessible loading state without legacy stylesheet classes", () => {
    const html = renderToStaticMarkup(createElement(LibraryDocumentList));

    expect(html).toContain('role="status"');
    expect(html).toContain("正在读取笔记...");
    expect(html).not.toContain("library-loading");
    expect(html).not.toContain("empty-state");
  });
});
