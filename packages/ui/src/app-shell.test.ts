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

  it("accepts workspace-specific settings and mobile navigation without replacing desktop links", () => {
    const html = renderToStaticMarkup(createElement(AppShell, {
      activeEntry: "learn",
      children: "内容",
      settingsHref: "/opening/settings",
      navigation: createElement("nav", { "aria-label": "桌面导航" }, "完整导航"),
      mobileNavigation: createElement("nav", { "aria-label": "手机导航" }, "核心导航"),
    }));
    expect(html).toContain('href="/opening/settings"');
    expect(html).not.toContain('href="/settings"');
    expect(html).toContain('aria-label="桌面导航"');
    expect(html).toContain('aria-label="手机导航"');
    expect(html.match(/完整导航/g)).toHaveLength(1);
    expect(html.match(/核心导航/g)).toHaveLength(1);
  });
  it("supports settings and theme in a sidebar footer", () => {
    const expanded = renderToStaticMarkup(createElement(AppShell, { activeEntry: "learn", children: "内容", sidebarFooter: createElement("div", null, "主题设置") }));
    expect(expanded).toContain("主题设置");
  });

});
