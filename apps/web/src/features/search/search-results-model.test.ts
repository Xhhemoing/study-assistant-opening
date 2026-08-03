import { describe, expect, it } from "vitest";
import type { SearchHit } from "@aistudy/domain";
import { groupSearchHits, searchHitHref } from "./search-results-model";

function hit(type: SearchHit["type"], id: string): SearchHit {
  return { id, type, title: `${type}-${id}`, snippet: "摘要", score: 1 };
}

describe("search result model", () => {
  it("groups hits in a stable type order and omits empty groups", () => {
    const groups = groupSearchHits([
      hit("practice", "p1"),
      hit("document", "d1"),
      hit("practice", "p2"),
      hit("exploration", "e1"),
    ]);

    expect(groups.map((group) => group.type)).toEqual(["document", "exploration", "practice"]);
    expect(groups[2]?.hits.map((item) => item.id)).toEqual(["p1", "p2"]);
  });

  it("maps every search type to its owning route", () => {
    expect(searchHitHref(hit("document", "d/1"))).toBe("/library/d%2F1");
    expect(searchHitHref(hit("exploration", "e1"))).toBe("/explore/e1");
    expect(searchHitHref(hit("card", "c1"))).toBe("/learn/review?cardId=c1");
    expect(searchHitHref(hit("course", "course 1"))).toBe("/learn/courses/course%201");
    expect(searchHitHref(hit("practice", "p1"))).toBe("/learn/practice/p1");
  });
});
