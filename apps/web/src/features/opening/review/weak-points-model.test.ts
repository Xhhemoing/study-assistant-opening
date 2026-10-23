import { describe, expect, it } from "vitest";
import { buildWeakPoints, practiceHref, retestQueueHref, readCauses, weakPointsSummarySchema, type WeakPointsRead } from "./weak-points-model";

const C = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
type Feature = WeakPointsRead["features"][number];
const time = (day: number) => new Date(Date.UTC(2026, 9, day)).toISOString();
function feature(id: string, requirementKey = "span", day = 1, overrides: Partial<Feature> = {}): Feature {
  return { observationId: id, courseId: C, requirementKey, skillLabel: "求系数", attemptedAt: time(day),
    eligibility: { verifiedCorrect: "no", independentAttempt: "yes", usableForCurrentVersion: "yes", usableForDelayedCheck: "no", reasonCodes: [], policyVersion: "opening-evidence-v3" },
    views: [], retention: { protocolId: null, earliestAt: null, recordedIntervalSupportCount: null, intervalExposureComplete: null }, ...overrides };
}
const correct = (row: Feature, delayed = false): Feature => ({ ...row,
  eligibility: { ...row.eligibility, verifiedCorrect: "yes", usableForDelayedCheck: delayed ? "yes" : "no" },
  views: delayed ? ["independent", "retention"] : ["independent"],
  retention: { ...row.retention, protocolId: delayed ? "protocol" : null },
});
function read(features: Feature[], due: string[] = [], overrides: Partial<WeakPointsRead> = {}): WeakPointsRead {
  return { dataAsOf: time(25), features,
    display: { requirements: due.map(requirementKey => ({ courseId: C, requirementKey, dueRetest: true })) },
    completeness: { total: features.length, status: "complete" }, ...overrides };
}
const build = (input: WeakPointsRead) => buildWeakPoints(input, new Map([[C, "线代"]]));

describe("qualified weak-point summary", () => {
  it("counts more than 200 effective answers and lowers priority after a later independent success", () => {
    const oldErrors = Array.from({ length: 250 }, (_, index) => feature(`old-${index}`, "old-errors", 1));
    const result = build(read([...oldErrors, correct(feature("new", "old-errors", 5)), feature("recent", "recent", 4)]));
    expect(result.incomplete).toBe(false);
    expect(result.points.map(point => point.requirementKey)).toEqual(["recent", "old-errors"]);
    expect(result.points[1]).toMatchObject({ incorrect: 250, independentCorrect: 1, total: 251, state: "recent_independent", courseTitle: "线代" });
    expect(weakPointsSummarySchema.parse(result)).toEqual(result);
  });

  it("keeps stable requirements across renames and separates different requirements with the same label", () => {
    const rows = [feature("old"), correct(feature("renamed", "span", 2, { skillLabel: "线性组合" })), feature("other", "matrix", 3), feature("other-course", "span", 4, { courseId: OTHER })];
    const { points } = build(read(rows));
    expect(points).toHaveLength(3);
    expect(points.find(point => point.requirementKey === "span" && point.courseId === C)).toMatchObject({ skillLabel: "线性组合", total: 2, incorrect: 1 });
    expect(new Set(points.map(point => point.key)).size).toBe(3);
  });

  it("does not merge unassigned records or infer improvement from their display label", () => {
    const { points } = build(read([feature("a", "", 1), correct(feature("b", "", 2)), feature("c", "span", 3, { requirementKey: null })]));
    expect(points).toHaveLength(3);
    expect(points.every(point => point.state === "needs_check" && !point.identityKnown)).toBe(true);
    expect(new Set(points.map(point => point.key)).size).toBe(3);
  });

  it("requires correct independent current evidence and a delay protocol before showing delayed success", () => {
    const previous = feature("old");
    const delayed = correct(feature("new", "span", 2), true);
    expect(build(read([previous, delayed])).points[0]?.state).toBe("delayed_checked");
    for (const change of [
      { eligibility: { ...delayed.eligibility, verifiedCorrect: "no" as const } },
      { eligibility: { ...delayed.eligibility, independentAttempt: "no" as const } },
      { eligibility: { ...delayed.eligibility, usableForCurrentVersion: "unknown" as const } },
      { retention: { ...delayed.retention, protocolId: null } },
      { views: [] },
    ]) expect(build(read([previous, { ...delayed, ...change }])).points[0]?.state).not.toBe("delayed_checked");
  });

  it("puts actual due checks ahead of practice even when the most recent answer was correct", () => {
    const { points } = build(read([feature("error", "practice", 4), feature("old", "due", 1), correct(feature("passed", "due", 2), true)], ["due"]));
    expect(points.map(point => point.state)).toEqual(["due_retest", "needs_practice"]);
  });

  it("retains old errors as history while stale and unknown qualifications require checking", () => {
    const stale = feature("old", "stale", 4);
    const unknown = feature("unknown", "unknown", 5);
    const { points } = build(read([
      { ...stale, eligibility: { ...stale.eligibility, usableForCurrentVersion: "no" } },
      { ...unknown, eligibility: { ...unknown.eligibility, verifiedCorrect: "unknown", independentAttempt: "unknown" } },
      feature("current", "current", 2),
    ]));
    expect(points[0]).toMatchObject({ requirementKey: "current", state: "needs_practice" });
    expect(points.find(point => point.requirementKey === "stale")).toMatchObject({ incorrect: 1, state: "needs_check" });
    expect(points.find(point => point.requirementKey === "unknown")).toMatchObject({ incorrect: 0, assisted: 0, state: "needs_check" });
  });

  it("does not choose a winner for conflicting answers with equal original-attempt timestamps", () => {
    for (const rows of [[feature("a"), correct(feature("b"))], [correct(feature("b")), feature("a")]]) {
      expect(build(read(rows)).points[0]?.state).toBe("needs_check");
    }
  });

  it("shows non-independent success as practice and omits topics without struggle or an open check", () => {
    const assisted = correct(feature("helped", "helped"));
    assisted.eligibility.independentAttempt = "no";
    expect(build(read([assisted, correct(feature("pass", "clean"))])).points).toMatchObject([{ requirementKey: "helped", assisted: 1, incorrect: 0, state: "needs_practice" }]);
  });

  it("distinguishes truncated evidence details from genuinely incomplete full features", () => {
    const rows = [feature("a")];
    expect(build(read(rows, [], { completeness: { status: "truncated", total: 1 } })).incomplete).toBe(false);
    expect(build(read(rows, [], { completeness: { status: "truncated", total: 2 } })).incomplete).toBe(true);
    expect(build(read([], [], { completeness: { status: "unavailable", total: 0 } })).incomplete).toBe(true);
  });

  it("preserves the exact skill and stable requirement in practice links", () => {
    const url = new URL(practiceHref({ courseId: C, skillLabel: "求 系数", requirementKey: "span:v1" }), "https://study.test");
    expect(url.pathname).toBe(`/opening/courses/${C}/study`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ mode: "practice", skillLabel: "求 系数", requirementKey: "span:v1" });
    expect(new URL(practiceHref({ courseId: C, skillLabel: "x", requirementKey: null }), "https://study.test").searchParams.has("requirementKey")).toBe(false);
    const retest = new URL(retestQueueHref({ courseId: C, requirementKey: "span:v1" }), "https://study.test");
    expect(retest.pathname).toBe("/opening/review");
    expect(Object.fromEntries(retest.searchParams)).toEqual({ tab: "retests", courseId: C, requirementKey: "span:v1" });
    expect(readCauses({ getItem: () => JSON.stringify({ k: "calc", j: "bogus" }) })).toEqual({ k: "calc" });
    expect(readCauses({ getItem: () => "{bad" })).toEqual({});
  });
});
