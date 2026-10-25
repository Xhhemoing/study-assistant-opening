import { describe, expect, it } from "vitest";
import { legacyOpeningRedirectPath } from "../../../middleware";
import { navigationIsActive, openingNavigation } from "./navigation";

describe("workspace navigation", () => {
  it("uses four shared destinations and keeps secondary tools out of primary navigation", () => {
    expect(openingNavigation().filter(item => item.group === "core").map(item => [item.href, item.label])).toEqual([
      ["/opening/today", "开始"], ["/opening/courses", "课程"],
      ["/opening/agent", "助理"], ["/opening/library", "资料"],
    ]);
  });
  it("highlights only the matching primary or tool entry", () => {
    for (const pathname of ["/opening/review", "/opening/cards/session", "/opening/sprint", "/opening/search", "/opening/courses/id/study", "/opening/assistant", "/opening/suggestions"]) {
      const active = openingNavigation().filter(item => navigationIsActive(item.href, pathname));
      expect(active).toHaveLength(1);
      const expected = pathname.startsWith("/opening/assistant") || pathname.startsWith("/opening/suggestions") ? "/opening/today" : pathname.startsWith("/opening/cards") ? "/opening/review" : pathname.startsWith("/opening/courses") ? "/opening/courses" : pathname;
      expect(active[0]?.href).toBe(expected);
    }
  });
  it.each([
    ["/opening/review", "tab=cards", "/opening/review"],
    ["/opening/courses/course-a", "mode=sprint", "/opening/sprint"],
    ["/opening/review", "tab=session", "/opening/review"],
    ["/opening/courses/course-a/study", "mode=sprint", "/opening/courses"],
    ["/opening/review", "tab=cards&tab=all", "/opening/review"],
    ["/opening/courses/course-a", "mode=sprint&mode=practice", "/opening/courses"],
  ])("keeps one owner after a shared-page redirect: %s?%s", (pathname, search, expected) => {
    expect(openingNavigation().filter(item => navigationIsActive(item.href, pathname, search)).map(item => item.href)).toEqual([expected]);
  });
  it("has no alias entries that only redirect to another destination", () => {
    const hrefs = openingNavigation().map(item => item.href);
    expect(hrefs).not.toContain("/opening/cards");
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
  it("keeps course detail active inside Opening", () => {
    expect(navigationIsActive("/opening/courses", "/opening/courses/123")).toBe(true);
    expect(navigationIsActive("/opening/courses", "/learn/courses/123")).toBe(false);
    expect(navigationIsActive("/opening/review", "/opening/cardsx")).toBe(false);
    expect(navigationIsActive("/opening/review", "/opening/cards")).toBe(true);
    expect(navigationIsActive("/opening/review", "/opening/review/x")).toBe(true);
    expect(navigationIsActive("/opening/settings/connections", "/opening/settings/connections")).toBe(true);
  });
  it("highlights notes entry for opening library and note editor paths", () => {
    expect(navigationIsActive("/opening/library", "/opening/library")).toBe(true);
    expect(navigationIsActive("/opening/library", "/opening/library/doc-1")).toBe(true);
    expect(navigationIsActive("/opening/library", "/opening/library/new")).toBe(true);
    expect(navigationIsActive("/opening/library", "/opening/courses")).toBe(false);
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
