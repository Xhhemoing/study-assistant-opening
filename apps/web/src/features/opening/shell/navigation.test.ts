import { describe, expect, it } from "vitest";
import { navigationIsActive, openingNavigation } from "./navigation";

describe("workspace navigation", () => {
  it("keeps the assistant and three learning modes directly reachable", () => {
    const links = openingNavigation().map(item => item.href);
    for (const href of ["/opening/today", "/opening/assistant", "/learn", "/explore", "/library", "/opening/courses"]) expect(links).toContain(href);
    expect(new Set(links).size).toBe(links.length);
  });
  it("groups daily core entries, with the knowledge base, ahead of learning modes", () => {
    const groups = openingNavigation().map(item => item.group);
    expect(groups.lastIndexOf("core")).toBeLessThan(groups.indexOf("modes"));
    expect(openingNavigation().find(item => item.href === "/library")?.group).toBe("core");
  });
  it("keeps the knowledge base active on its opening alias", () => {
    expect(navigationIsActive("/library", "/opening/library")).toBe(true);
    expect(navigationIsActive("/library", "/library/abc")).toBe(true);
  });
  it("assigns legacy course routes only to the course entry", () => {
    expect(navigationIsActive("/opening/courses", "/learn/courses/123")).toBe(true);
    expect(navigationIsActive("/learn", "/learn/courses/123")).toBe(false);
    expect(navigationIsActive("/learn", "/learn/goals/123")).toBe(true);
    expect(navigationIsActive("/explore", "/explorer")).toBe(false);
  });
});
