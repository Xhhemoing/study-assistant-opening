import { describe, expect, it } from "vitest";
import { legacyOpeningRedirectPath } from "../../../middleware";
import { navigationIsActive, openingNavigation } from "./navigation";

describe("workspace navigation", () => {
  it("exposes Opening core loop entries plus cards, review, and connections", () => {
    const links = openingNavigation().map(item => item.href);
    expect(links).toEqual([
      "/opening/today",
      "/opening/assistant",
      "/opening/courses",
      "/opening/cards",
      "/opening/review",
      "/opening/settings/connections",
    ]);
    expect(openingNavigation().filter(item => item.group === "core").map(item => item.href)).toEqual([
      "/opening/today",
      "/opening/assistant",
      "/opening/courses",
    ]);
    expect(openingNavigation().filter(item => item.group === "more").map(item => item.href)).toEqual([
      "/opening/cards",
      "/opening/review",
      "/opening/settings/connections",
    ]);
  });
  it("keeps course detail active inside Opening", () => {
    expect(navigationIsActive("/opening/courses", "/opening/courses/123")).toBe(true);
    expect(navigationIsActive("/opening/courses", "/learn/courses/123")).toBe(false);
    expect(navigationIsActive("/learn", "/learn/courses/123")).toBe(false);
    expect(navigationIsActive("/learn", "/learn/goals/123")).toBe(true);
    expect(navigationIsActive("/explore", "/explorer")).toBe(false);
    expect(navigationIsActive("/opening/cards", "/opening/cards")).toBe(true);
    expect(navigationIsActive("/opening/review", "/opening/review/x")).toBe(true);
    expect(navigationIsActive("/opening/settings/connections", "/opening/settings/connections")).toBe(true);
  });
  it("redirects nested preview pages during the Opening release", () => {
    expect(legacyOpeningRedirectPath("/preview/notion-import")).toBe("/opening/today");
    expect(legacyOpeningRedirectPath("/preview/notion-import/detail")).toBe("/opening/today");
    expect(legacyOpeningRedirectPath("/preview-old")).toBeNull();
    expect(legacyOpeningRedirectPath("/learn/courses/123")).toBeNull();
  });
  it("redirects nested mock learning entries without touching course routes", () => {
    expect(legacyOpeningRedirectPath("/learn/review")).toBe("/opening/cards");
    expect(legacyOpeningRedirectPath("/learn/review/abc")).toBe("/opening/cards");
    expect(legacyOpeningRedirectPath("/learn/practice/123")).toBe("/opening/today");
    expect(legacyOpeningRedirectPath("/learn/goals/new")).toBe("/opening/today");
    expect(legacyOpeningRedirectPath("/learn/exams")).toBe("/opening/today");
    expect(legacyOpeningRedirectPath("/learn/marketplace")).toBe("/opening/today");
    expect(legacyOpeningRedirectPath("/learn/courses/123")).toBeNull();
  });
});
