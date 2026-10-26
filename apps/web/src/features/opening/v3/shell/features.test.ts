import { describe, expect, it } from "vitest";
import { FEATURES, NAV_CORE, NAV_TOOLS, activeNavId, featureHref, navDirection, resolveFeature } from "./features";

describe("UI v3 feature registry", () => {
  it("resolves static segments before dynamic ones", () => {
    expect(resolveFeature("/opening/courses/new")?.id).toBe("course-new");
    expect(resolveFeature("/opening/courses/abc")?.id).toBe("course");
    expect(resolveFeature("/opening/courses/abc/study/matrix")?.id).toBe("study-matrix");
    expect(resolveFeature("/opening/library/new")?.id).toBe("library-new");
    expect(resolveFeature("/opening/library/doc-1?pos=3")?.id).toBe("document");
    expect(resolveFeature("/opening/courses/abc/study/summary")?.id).toBe("study-summary");
    expect(resolveFeature("/opening/review/session")?.id).toBe("review-session");
  });

  it("highlights exactly one navigation entry per path", () => {
    expect(activeNavId("/opening/assistant")).toBe("today");
    expect(activeNavId("/opening/courses/abc/study")).toBe("today");
    expect(activeNavId("/opening/agent")).toBe("today");
    expect(activeNavId("/opening/sprint")).toBe("today");
    expect(activeNavId("/opening/search")).toBe("library");
    expect(activeNavId("/opening/settings/export")).toBe("settings");
    expect(activeNavId("/login")).toBeNull();
  });

  it("derives only three primary destinations and no duplicate tools", () => {
    expect(NAV_CORE.map(item => [item.route, item.label])).toEqual([["/opening/today", "学习"], ["/opening/review", "复习"], ["/opening/library", "资料"]]);
    expect(NAV_TOOLS).toEqual([]);
  });

  it("derives transition direction from depth", () => {
    expect(navDirection("/opening/courses", "/opening/courses/abc/study")).toBe("forward");
    expect(navDirection("/opening/courses/abc/study", "/opening/courses/abc")).toBe("back");
    expect(navDirection("/opening/review", "/opening/library")).toBe("swap");
  });

  it("builds hrefs and covers every opening route once", () => {
    expect(featureHref("course", { id: "abc" })).toBe("/opening/courses/abc");
    const routes = FEATURES.map(feature => feature.route);
    expect(new Set(routes).size).toBe(routes.length);
  });
});
