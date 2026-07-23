import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WorkspaceNavigation,
  getWorkspaceEntry,
  workspaceNavigationItems,
} from "./workspace-navigation";

describe("WorkspaceNavigation", () => {
  it("exposes three equally prominent workspace entries", () => {
    expect(workspaceNavigationItems).toEqual([
      { href: "/learn", label: "Learn", key: "learn" },
      { href: "/explore", label: "Explore", key: "explore" },
      { href: "/library", label: "Library", key: "library" },
    ]);
  });

  it("renders all entries as keyboard-accessible navigation links", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceNavigation, { activeEntry: "explore" }),
    );

    expect(html).toContain('aria-label="Workspace navigation"');
    expect(html).toContain('href="/learn"');
    expect(html).toContain('href="/explore"');
    expect(html).toContain('href="/library"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('data-entry="explore"');
    expect(html.match(/<a /g)).toHaveLength(3);
  });

  it("supports the mobile bottom navigation presentation", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceNavigation, {
        activeEntry: "learn",
        placement: "bottom",
      }),
    );

    expect(html).toContain('data-navigation-placement="bottom"');
  });

  it("restores a valid remembered default and falls back safely", () => {
    expect(getWorkspaceEntry("explore")).toBe("explore");
    expect(getWorkspaceEntry("unknown")).toBe("learn");
    expect(getWorkspaceEntry(null)).toBe("learn");
  });
});
