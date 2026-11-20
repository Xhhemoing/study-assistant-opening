import { describe, expect, it } from "vitest";
import { navigationIsActive, openingNavigation } from "./navigation";

const options = { studySessionV2: true };

describe("study session V2 navigation", () => {
  it("exposes today, courses, explore and library in order", () => {
    expect(openingNavigation(options).map(item => [item.href, item.label, item.icon, item.group])).toEqual([
      ["/opening/today", "今日", "start", "core"],
      ["/opening/courses", "课程", "courses", "core"],
      ["/opening/agent", "探索", "assistant", "core"],
      ["/opening/library", "资料", "library", "core"],
    ]);
  });

  it.each([
    ["/opening/today", "/opening/today"],
    ["/opening/review", "/opening/today"],
    ["/opening/review/session?tab=cards", "/opening/today"],
    ["/opening/cards", "/opening/today"],
    ["/opening/cards/session", "/opening/today"],
    ["/opening/agent", "/opening/agent"],
    ["/opening/assistant", "/opening/agent"],
    ["/opening/sprint", "/opening/today"],
    ["/opening/suggestions", "/opening/today"],
    ["/opening/courses", "/opening/courses"],
    ["/opening/courses/course-a", "/opening/courses"],
    ["/opening/courses/course-a/study?mode=sprint", "/opening/courses"],
    ["/opening/library", "/opening/library"],
    ["/opening/library/doc-a", "/opening/library"],
    ["/opening/map", "/opening/library"],
    ["/opening/map?context=course&id=course/10000000-0000-4000-8000-000000000001", "/opening/library"],
    ["/opening/search", "/opening/library"],
  ])("selects one owner for %s", (pathname, expected) => {
    expect(openingNavigation(options).filter(item => navigationIsActive(item.href, pathname, "", options)).map(item => item.href)).toEqual([expected]);
  });

  it.each(["/opening/coursesx", "/opening/reviewx", "/opening/cardsx", "/opening/searchx", "/opening/mapx", "/opening/settings"])("does not select a core destination for %s", pathname => {
    expect(openingNavigation(options).filter(item => navigationIsActive(item.href, pathname, "", options))).toEqual([]);
  });

  it("keeps explicitly disabled navigation identical to the default", () => {
    expect(openingNavigation({ studySessionV2: false })).toEqual(openingNavigation());
    for (const pathname of ["/opening/courses/course-a", "/opening/review", "/opening/cards", "/opening/search"]) {
      for (const item of openingNavigation()) {
        expect(navigationIsActive(item.href, pathname, "", { studySessionV2: false })).toBe(navigationIsActive(item.href, pathname));
      }
    }
  });
});
