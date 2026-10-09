import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell, SIDEBAR_COLLAPSED_STORAGE_KEY } from "./app-shell";

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

  it("exposes a desktop sidebar collapse toggle without changing mobile nav", () => {
    const collapsed = renderToStaticMarkup(createElement(AppShell, {
      activeEntry: "learn",
      children: "内容",
      sidebarCollapsed: true,
      onToggleSidebar: () => undefined,
    }));
    expect(SIDEBAR_COLLAPSED_STORAGE_KEY).toBe("aistudy.shell.sidebarCollapsed");
    expect(collapsed).toContain('data-sidebar-collapsed="true"');
    expect(collapsed).toContain('data-sidebar-toggle="true"');
    expect(collapsed).toContain('aria-label="展开侧栏"');
    expect(collapsed).toContain('data-shell-navigation="mobile"');

    const expanded = renderToStaticMarkup(createElement(AppShell, {
      activeEntry: "learn",
      children: "内容",
      sidebarCollapsed: false,
      onToggleSidebar: () => undefined,
    }));
    expect(expanded).toContain('data-sidebar-collapsed="false"');
    expect(expanded).toContain('aria-label="收起侧栏"');
  });
});
