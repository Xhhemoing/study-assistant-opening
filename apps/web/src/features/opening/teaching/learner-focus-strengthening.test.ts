import { describe, expect, it } from "vitest";
import type { SnapshotObservation, LearnerSnapshotSources } from "@aistudy/domain";
import { assembleLearnerSnapshot } from "@aistudy/domain";
import type { LearnerSnapshotRead } from "../planning/learner-snapshot-service";
import { teachingLearnerFocus } from "./learner-focus";
import { collectSkillLabelOptions, findSkillLabelReuseHint } from "../learning/skill-label-options";

const courseId = "11111111-1111-4111-8111-111111111111";
const observationId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-10-21T12:00:00Z");
const base: SnapshotObservation = { id: observationId, skillLabel: "Linear Algebra", requirementKey: "calculate", problemId: null,
  attemptedAt: "2026-10-20T00:00:00Z", usableForCurrentVersion: "yes", verifiedCorrect: "no", independentAttempt: "yes", assistance: "independent",
  errors: [{ observationId, label: "equation", feedback: "write one consistent equation", source: "verified_steps" }] };
function read(observations: SnapshotObservation[] = [base]): LearnerSnapshotRead {
  const sources: LearnerSnapshotSources = { date: "2026-10-21", timeZone: "UTC", dueCardCount: 0, tasks: [], courses: [{
    courseId, title: "Math", goal: null, hasUsableMaterials: true, evidenceStatus: "available", knowledgeNodes: [], observations,
    summaries: [{ skillLabel: "Linear Algebra", requirementKey: "calculate", status: "needs_check", lastObservedAt: base.attemptedAt }],
  }] };
  return { sources, snapshot: assembleLearnerSnapshot(sources), autonomy: "copilot", plannerInputRevision: "r1",
    dataStatus: { evidence: "available", goals: "available", dueCards: "available" }, metrics: { reads: 4, durationMs: 1 } };
}
const get = (value: LearnerSnapshotRead, skill: string | null = "Linear Algebra", key?: string | null, full = false) =>
  teachingLearnerFocus(value, courseId, skill, full, key, now);

describe("focus selects current same-requirement facts, not display label collisions", () => {
  it.each([" LINEAR algebra ", "Ｌｉｎｅａｒ　Ａｌｇｅｂｒａ", "Linear\nAlgebra", "linearalgebra"])("alias %s preserves original display label and exact observation", alias => {
    expect(get(read(), alias, "calculate")).toMatchObject({ skillLabel: "Linear Algebra", requirementKey: "calculate", activityKind: "targeted_explain", focusObservationId: observationId, recentErrors: base.errors });
  });
  it.each(["prove", "", null])("does not borrow calculate from requested key %s", key => {
    const result = get(read(), "Linear Algebra", key);
    expect(result).toMatchObject({ requirementKey: key, activityKind: "diagnose", focusObservationId: null, recentErrors: [], recentAssistance: [] });
  });
  it("an explicit unassigned requirement does not borrow a named key", () => {
    expect(get(read(), "Linear Algebra", null)?.requirementKey).toBeNull();
    expect(get(read(), "Linear Algebra", null)?.focusObservationId).toBeNull();
  });
  it("omitted key may resolve only a unique saved requirement", () => {
    expect(get(read())?.focusObservationId).toBe(observationId);
    const value = read(); value.snapshot = { ...value.snapshot, courses: [{ ...value.snapshot.courses[0]!, skills: [...value.snapshot.courses[0]!.skills,
      { ...value.snapshot.courses[0]!.skills[0]!, requirementKey: "prove" }] }] };
    const result = get(value);
    expect(result).not.toHaveProperty("requirementKey");
    expect(result).toMatchObject({ activityKind: "diagnose", focusObservationId: null, recentErrors: [] });
  });
  it("same normalized label across courses cannot lend observations", () => {
    const value = read([]);
    value.sources.courses = [...value.sources.courses, { ...value.sources.courses[0]!, courseId: "other", observations: [base] }];
    expect(get(value, "Linear Algebra", "calculate")).toMatchObject({ activityKind: "diagnose", focusObservationId: null, recentErrors: [] });
  });
  it.each(["no", "unknown", undefined] as const)("stale/unknown current applicability %s cannot carry error feedback", usableForCurrentVersion => {
    expect(get(read([{ ...base, usableForCurrentVersion }]), "Linear Algebra", "calculate"))
      .toMatchObject({ activityKind: "diagnose", reasonCode: "no_evidence", recentErrors: [], recentAssistance: [], focusObservationId: null });
  });
  it.each(["no", "unknown", undefined] as const)("newer unusable %s success cannot erase a current error", usableForCurrentVersion => {
    const newer = { ...base, id: "newer", attemptedAt: "2026-10-21T00:00:00Z", verifiedCorrect: "yes" as const, usableForCurrentVersion };
    expect(get(read([newer, base]), "Linear Algebra", "calculate"))
      .toMatchObject({ activityKind: "targeted_explain", focusObservationId: observationId, recentAssistance: ["independent"] });
  });
  it("newer current unknown does not borrow an older independent success", () => {
    const older = { ...base, verifiedCorrect: "yes" as const };
    const newer = { ...base, id: "newer", attemptedAt: "2026-10-21T00:00:00Z", verifiedCorrect: "unknown" as const, independentAttempt: "unknown" as const, assistance: "unknown" as const, errors: undefined };
    expect(get(read([older, newer]), "Linear Algebra", "calculate"))
      .toMatchObject({ activityKind: "diagnose", focusObservationId: null, recentAssistance: ["unknown", "independent"] });
  });
  it("canonical newest-first order clips assistance and errors independently without source mutation", () => {
    const rows = [1,2,3,4].map(index => ({ ...base, id: String(index), attemptedAt: `2026-10-${16+index}T00:00:00Z`,
      errors: [{ ...base.errors![0]!, observationId: String(index), feedback: `error-${index}` }] }));
    const value = read(rows), before = JSON.stringify(value);
    expect(get(value, "Linear Algebra", "calculate")).toMatchObject({
      focusObservationId: "4", recentAssistance: ["independent", "independent", "independent"],
      recentErrors: [4,3,2].map(index => ({ ...base.errors![0]!, observationId: String(index), feedback: `error-${index}` })),
    });
    expect(JSON.stringify(value)).toBe(before);
  });
  it.each([[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]])("same-time effective facts remain deterministic under permutation %j/%j/%j", (a, b, c) => {
    const tied = [
      { ...base, id: "a", verifiedCorrect: "no" as const },
      { ...base, id: "b", verifiedCorrect: "yes" as const, errors: undefined },
      { ...base, id: "c", requirementKey: "prove", verifiedCorrect: "yes" as const, errors: undefined },
    ];
    const rows = [tied[a]!, tied[b]!, tied[c]!], before = JSON.stringify(rows);
    const result = get(read(rows), "Linear Algebra", "calculate");
    expect(result).toMatchObject({ activityKind: "targeted_explain", focusObservationId: "a",
      recentAssistance: ["independent", "independent"], recentErrors: base.errors });
    expect(JSON.stringify(rows)).toBe(before);
  });
  it("full explanation overrides verified error selection without converting feedback to fact", () => {
    const result = get(read(), "Linear Algebra", "calculate", true);
    expect(result).toMatchObject({ activityKind: "full_explain", focusObservationId: null, reasonCode: "requested_full", recentErrors: base.errors });
  });
  it("unavailable source evidence is not an empty successful evidence read", () => {
    const value = read(); value.sources.courses[0]!.evidenceStatus = "unavailable";
    expect(get(value)).toBeNull();
  });
  it("a missing snapshot course is not repaired by source-only observations", () => {
    const value = read(); value.snapshot.courses = [];
    expect(get(value)).toBeNull();
  });
  it("an empty explicit label does not trigger default skill selection", () => {
    expect(get(read(), "")).toBeNull();
  });
});

describe("label option display is a hint, never an attribution rewrite", () => {
  it.each([
    { name: "missing/null/blank", rows: [{}, { skillLabel: null }, { skillLabel: " " }, { identity: {} }], expected: [] },
    { name: "first spelling", rows: [{ skillLabel: " ＦＲＡＣＴＩＯＮＳ " }, { skillLabel: "Fractions" }, { identity: { skillLabel: "fractions" } }], expected: ["ＦＲＡＣＴＩＯＮＳ"] },
    { name: "nested identity takes precedence", rows: [{ identity: { skillLabel: "Nested" }, skillLabel: "Top" }], expected: ["Nested"] },
    { name: "empty nested identity not replaced by top field", rows: [{ identity: { skillLabel: "" }, skillLabel: "Top" }], expected: [] },
    { name: "punctuation is meaningful", rows: [{ skillLabel: "a-b" }, { skillLabel: "ab" }], expected: ["a-b", "ab"] },
  ])("$name", ({ rows, expected }) => {
    const before = JSON.stringify(rows); expect(collectSkillLabelOptions(rows)).toEqual(expected); expect(JSON.stringify(rows)).toBe(before);
  });
  it.each([
    ["linear  algebra", "Linear Algebra"], ["ＬＩＮＥＡＲ　ＡＬＧＥＢＲＡ", "Linear Algebra"],
    [" Linear Algebra ", null], ["Linear Algebra", null], ["new topic", null], ["\u2003", null],
  ])("reuse hint %s", (input, expected) => {
    expect(findSkillLabelReuseHint(input, ["Linear Algebra", "fractions"])).toBe(expected);
  });
  it("returns the saved first alias without mutating either option or typed text", () => {
    const options = Object.freeze(["ＦＲＡＣＴＩＯＮＳ", "Fractions"]), input = " fractions ";
    expect(findSkillLabelReuseHint(input, options)).toBe(options[0]);
    expect(input).toBe(" fractions "); expect(options).toEqual(["ＦＲＡＣＴＩＯＮＳ", "Fractions"]);
  });
});
