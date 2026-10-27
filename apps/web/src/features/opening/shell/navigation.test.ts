import { describe, expect, it } from "vitest";
import { legacyOpeningRedirectPath } from "../../../middleware";
import { navigationIsActive, openingNavigation } from "./navigation";

describe("workspace navigation", () => {
  it("has exactly the three learning destinations in order", () => {
    expect(openingNavigation().map(item => [item.href, item.label, item.group])).toEqual([
      ["/opening/today", "助理", "core"],
      ["/opening/courses", "学习", "core"],
      ["/opening/library", "知识库", "core"],
    ]);
  });
  it.each([
    ["/opening/today", "/opening/today"],
    ["/opening/courses", "/opening/courses"],
    ["/opening/courses/course-a/study", "/opening/courses"],
    ["/opening/courses/course-a?mode=sprint", "/opening/courses"],
    ["/opening/agent", "/opening/today"],
    ["/opening/assistant", "/opening/today"],
    ["/opening/sprint", "/opening/courses"],
    ["/opening/practice", "/opening/courses"],
    ["/opening/suggestions", "/opening/today"],
    ["/opening/cards/session", "/opening/courses"],
    ["/opening/review?tab=cards", "/opening/courses"],
    ["/opening/library/doc-1", "/opening/library"],
    ["/opening/search", "/opening/library"],
  ])("keeps one owner for %s", (pathname, expected) => {
    expect(openingNavigation().filter(item => navigationIsActive(item.href, pathname)).map(item => item.href)).toEqual([expected]);
  });
  it("keeps route boundaries and settings activation intact", () => {
    expect(navigationIsActive("/opening/courses", "/opening/coursesx")).toBe(false);
    expect(navigationIsActive("/opening/courses", "/opening/cardsx")).toBe(false);
    expect(navigationIsActive("/opening/courses", "/opening/cards")).toBe(true);
    expect(navigationIsActive("/opening/today", "/learn/courses/123")).toBe(false);
    expect(navigationIsActive("/opening/settings/connections", "/opening/settings/connections")).toBe(true);
  });
  it("redirects nested preview pages during the Opening release", () => {
    expect(legacyOpeningRedirectPath("/preview/notion-import")).toBe("/opening/today");
    expect(legacyOpeningRedirectPath("/preview/notion-import/detail")).toBe("/opening/today");
    expect(legacyOpeningRedirectPath("/preview-old")).toBeNull();
    expect(legacyOpeningRedirectPath("/learn/courses/123")).toBe("/opening/courses/123");
  });
  it("redirects nested mock learning entries and preserves legacy course identities", () => {
    expect(legacyOpeningRedirectPath("/learn/review")).toBe("/opening/cards");
    expect(legacyOpeningRedirectPath("/learn/review/abc")).toBe("/opening/cards");
    expect(legacyOpeningRedirectPath("/learn/practice/123")).toBe("/opening/today");
    expect(legacyOpeningRedirectPath("/learn/goals/new")).toBe("/opening/today");
    expect(legacyOpeningRedirectPath("/learn/exams")).toBe("/opening/today");
    expect(legacyOpeningRedirectPath("/learn/marketplace")).toBe("/opening/today");
    expect(legacyOpeningRedirectPath("/learn/courses/123")).toBe("/opening/courses/123");
  });
});
