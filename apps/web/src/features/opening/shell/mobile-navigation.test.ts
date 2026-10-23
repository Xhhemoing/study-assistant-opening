import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: ReactNode; href: string }) => createElement("a", props, children) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/opening/today" }));
import { OpeningMobileNavigation } from "./mobile-navigation";

describe("Opening mobile navigation", () => {
  it("shows exactly four full-size destinations", () => {
    const html = renderToStaticMarkup(createElement(OpeningMobileNavigation, { pathname: "/opening/today" }));
    expect(html.match(/<a /g)).toHaveLength(4);
    expect(html).not.toContain("更多");
    expect(html).toContain("/opening/agent");
    expect(html).toContain("资料");
  });
  it("keeps Today selected for legacy card URLs", () => {
    const html = renderToStaticMarkup(createElement(OpeningMobileNavigation, { pathname: "/opening/cards/session" }));
    expect(html).toMatch(/href="\/opening\/today"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/opening\/today"/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
  it("does not misidentify an adjacent route as a child", () => {
    const html = renderToStaticMarkup(createElement(OpeningMobileNavigation, { pathname: "/opening/courses-extra" }));
    expect(html).not.toContain('aria-current="page"');
  });
});
