import { describe, expect, it } from "vitest";
import type { SearchHit } from "@aistudy/domain";
import { groupSearchHits, openingSearchHitHref } from "./search-results-model";

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

  it("keeps Opening palette hits inside the Opening shell and drops hits without a surface", () => {
    expect(openingSearchHitHref(hit("document", "d/1"))).toBe("/opening/library/d%2F1");
    expect(openingSearchHitHref(hit("course", "course 1"))).toBe("/opening/courses/course%201");
    expect(openingSearchHitHref(hit("card", "c1"))).toBe("/opening/review?tab=cards");
    expect(openingSearchHitHref(hit("exploration", "e1"))).toBeNull();
    expect(openingSearchHitHref(hit("practice", "p1"))).toBeNull();
  });
});
