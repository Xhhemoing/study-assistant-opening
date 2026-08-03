import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell";

describe("AppShell utility cluster", () => {
  it("renders global search and settings actions", () => {
    const html = renderToStaticMarkup(createElement(AppShell, {
      activeEntry: "learn",
      children: "内容",
      onOpenCommandPalette: () => undefined,
    }));

    expect(html).toContain('data-shell-utilities="true"');
    expect(html).toContain('aria-label="打开全局搜索"');
    expect(html).toContain('href="/settings"');
  });
});
