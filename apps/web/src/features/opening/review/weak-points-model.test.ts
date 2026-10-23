import { describe, expect, it } from "vitest";
import { buildWeakPoints, effectiveObservations, practiceHref, readCauses } from "./weak-points-model";

const C = "11111111-1111-4111-8111-111111111111";
const obs = (id: string, skillLabel: string, outcome: "correct" | "incorrect" | "unverified", assistance: "independent" | "hinted" | "revealed" | "unknown", occurredAt: string, extra: Record<string, unknown> = {}) =>
  ({ id, courseId: C, skillLabel, outcome, assistance, occurredAt, ...extra });

describe("weak points", () => {
  it("groups struggles by skill and ranks by count then recency", () => {
    const points = buildWeakPoints([
      obs("a", "求系数", "incorrect", "independent", "2026-10-01T00:00:00Z"),
      obs("b", "求系数", "correct", "hinted", "2026-10-02T00:00:00Z"),
      obs("c", "求系数", "correct", "independent", "2026-10-03T00:00:00Z"),
      obs("d", "span 几何", "incorrect", "independent", "2026-10-05T00:00:00Z"),
      obs("e", "矩阵乘法", "correct", "independent", "2026-10-05T00:00:00Z"),
    ], new Map([[C, "线代"]]));
    expect(points.map(point => point.skillLabel)).toEqual(["求系数", "span 几何"]);
    expect(points[0]).toMatchObject({ incorrect: 1, assisted: 1, independentCorrect: 1, total: 3, courseTitle: "线代", lastStruggleAt: "2026-10-02T00:00:00Z" });
  });

  it("drops retracted and superseded attempts", () => {
    const rows = [
      obs("a", "x", "incorrect", "independent", "2026-10-01T00:00:00Z"),
      obs("b", "x", "correct", "independent", "2026-10-01T00:00:00Z", { revisesObservationId: "a", revisionKind: "replace" }),
      obs("c", "y", "incorrect", "independent", "2026-10-01T00:00:00Z", { revisionKind: "retract" }),
    ];
    expect(effectiveObservations(rows).map(row => row.id)).toEqual(["b"]);
    expect(buildWeakPoints(rows, new Map())).toEqual([]);
  });

  it("links to focused practice and ignores invalid stored causes", () => {
    expect(practiceHref({ courseId: C, skillLabel: "求 系数" })).toBe(`/opening/courses/${C}/study?mode=practice&skillLabel=%E6%B1%82%20%E7%B3%BB%E6%95%B0`);
    expect(readCauses({ getItem: () => JSON.stringify({ k: "calc", j: "bogus" }) })).toEqual({ k: "calc" });
    expect(readCauses({ getItem: () => "{bad" })).toEqual({});
  });
});
