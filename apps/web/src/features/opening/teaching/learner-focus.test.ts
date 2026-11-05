import { expect, it } from "vitest";
import { ADAPTIVE_STRATEGY_VERSION, assembleLearnerSnapshot, type LearnerSnapshotSources, type SnapshotObservation } from "@aistudy/domain";
import type { LearnerSnapshotRead } from "../planning/learner-snapshot-service";
import { teachingLearnerFocus } from "./learner-focus";

const courseId = "11111111-1111-4111-8111-111111111111";
function read(correct: SnapshotObservation["verifiedCorrect"], assisted = false): LearnerSnapshotRead {
  const sources: LearnerSnapshotSources = {
    date: "2026-10-16", timeZone: "UTC", dueCardCount: 0, tasks: [],
    courses: [{ courseId, title: "Math", goal: null, hasUsableMaterials: true, evidenceStatus: "available", knowledgeNodes: [],
      summaries: [{ skillLabel: "Linear Algebra", status: correct === "yes" && !assisted ? "observed_independent" : "needs_check", lastObservedAt: "2026-10-16T08:00:00Z" }],
      observations: [{ id: "22222222-2222-4222-8222-222222222222", skillLabel: "Linear Algebra", attemptedAt: "2026-10-16T08:00:00Z",
        usableForCurrentVersion: "yes", verifiedCorrect: correct, independentAttempt: assisted ? "no" : "yes", assistance: assisted ? "hinted" : "independent", problemId: null }],
    }],
  };
  return { sources, snapshot: assembleLearnerSnapshot(sources), autonomy: "copilot", plannerInputRevision: "r1",
    dataStatus: { evidence: "available", goals: "available", dueCards: "available" }, metrics: { reads: 4, durationMs: 1 } };
}

it.each([
  ["unknown", "diagnose"], ["no", "targeted_explain"], ["yes", "transfer_check"],
] as const)("maps %s evidence for the actual task skill to %s", (correct, activityKind) => {
  const result = teachingLearnerFocus(read(correct), courseId, " LINEAR algebra ", false);
  expect(result).toMatchObject({ skillLabel: "Linear Algebra", activityKind, strategyVersion: ADAPTIVE_STRATEGY_VERSION });
  expect(result?.focusObservationId).toBe(correct === "no" ? "22222222-2222-4222-8222-222222222222" : null);
});

it.each([
  { verifiedCorrect: "unknown" as const, independentAttempt: "unknown" as const, reasonCode: "unverified_only" },
  { verifiedCorrect: "yes" as const, independentAttempt: "no" as const, reasonCode: "needs_check" },
])("does not trust an independent summary over current $verifiedCorrect/$independentAttempt facts", fact => {
  const value = read("yes"), source = value.sources.courses[0]!;
  source.observations = [{ ...source.observations[0]!, verifiedCorrect: fact.verifiedCorrect,
    independentAttempt: fact.independentAttempt, assistance: "unknown" }];
  // Intentionally keep the previously read snapshot summary independent.
  expect(value.snapshot.courses[0]!.skills[0]!.status).toBe("observed_independent");
  expect(teachingLearnerFocus(value, courseId, "Linear Algebra", false)).toMatchObject({
    activityKind: "diagnose", reasonCode: fact.reasonCode, focusObservationId: null, recentAssistance: ["unknown"],
  });
});

it("uses canonical ordering for shuffled observations and stable ties without mutating the source", () => {
  const value = read("yes"), source = value.sources.courses[0]!, base = source.observations[0]!;
  const earlier = { ...base, id: "z", attemptedAt: "2026-10-15T08:00:00Z" };
  const tiedWrong = { ...base, id: "a", verifiedCorrect: "no" as const, independentAttempt: "no" as const };
  const tiedCorrect = { ...base, id: "b" };
  for (const observations of [[earlier, tiedCorrect, tiedWrong], [tiedWrong, earlier, tiedCorrect]]) {
    source.observations = observations;
    const originalOrder = observations.map(row => row.id);
    expect(teachingLearnerFocus(value, courseId, "Linear Algebra", false)).toMatchObject({
      activityKind: "targeted_explain", reasonCode: "verified_incorrect", focusObservationId: "a",
    });
    expect(source.observations.map(row => row.id)).toEqual(originalOrder);
  }
});

it("does not let older success plus an independent summary confirm the newest unknown attempt", () => {
  const value = read("yes"), source = value.sources.courses[0]!, base = source.observations[0]!;
  source.observations = [base, { ...base, id: "latest-unknown", attemptedAt: "2026-10-17T00:00:00Z",
    verifiedCorrect: "unknown", independentAttempt: "unknown", assistance: "unknown" }];
  expect(teachingLearnerFocus(value, courseId, "Linear Algebra", false)).toMatchObject({
    activityKind: "diagnose", reasonCode: "needs_check", focusObservationId: null,
    recentAssistance: ["unknown", "independent"],
  });
});

it("does not borrow current independent evidence from another course/requirement or stale rows", () => {
  const value = read("yes"), source = value.sources.courses[0]!, base = source.observations[0]!;
  source.observations = [
    { ...base, id: "stale", attemptedAt: "2026-10-18T00:00:00Z", usableForCurrentVersion: "no" },
    { ...base, id: "other-requirement", requirementKey: "other" },
    { ...base, id: "current", verifiedCorrect: "unknown", independentAttempt: "unknown", assistance: "unknown" },
  ];
  value.sources.courses.push({ ...source, courseId: "other-course", observations: [{ ...base, id: "other-course-success" }] });
  expect(teachingLearnerFocus(value, courseId, "Linear Algebra", false, null)).toMatchObject({
    requirementKey: null, activityKind: "diagnose", reasonCode: "unverified_only", focusObservationId: null,
    recentAssistance: ["unknown"], recentErrors: [],
  });
  expect(teachingLearnerFocus(value, courseId, "Linear Algebra", true, null)).toMatchObject({
    activityKind: "full_explain", reasonCode: "requested_full", focusObservationId: null,
  });
});

it("keeps assisted success separate and honors an explicit full explanation", () => {
  expect(teachingLearnerFocus(read("yes", true), courseId, "Linear Algebra", false)?.activityKind).toBe("reduced_help_practice");
  expect(teachingLearnerFocus(read("no"), courseId, "Linear Algebra", true)).toMatchObject({ activityKind: "full_explain", focusObservationId: null });
});

it("selects the precise requirement and leaves ambiguous label-only tasks in diagnosis", () => {
  const value = read("yes");
  const source = value.sources.courses[0]!;
  source.summaries = [{ ...source.summaries[0]!, requirementKey: "calculate" },
    { ...source.summaries[0]!, requirementKey: "prove", status: "needs_check" }];
  source.observations = [{ ...source.observations[0]!, requirementKey: "calculate" },
    { ...source.observations[0]!, id: "33333333-3333-4333-8333-333333333333", requirementKey: "prove", verifiedCorrect: "no" }];
  value.snapshot = assembleLearnerSnapshot(value.sources);
  expect(teachingLearnerFocus(value, courseId, "Linear Algebra", false, "calculate"))
    .toMatchObject({ requirementKey: "calculate", activityKind: "transfer_check", focusObservationId: null });
  expect(teachingLearnerFocus(value, courseId, "Linear Algebra", false, "prove"))
    .toMatchObject({ requirementKey: "prove", activityKind: "targeted_explain", focusObservationId: "33333333-3333-4333-8333-333333333333" });
  expect(teachingLearnerFocus(value, courseId, "Linear Algebra", false))
    .toMatchObject({ activityKind: "diagnose", focusObservationId: null, recentAssistance: [] });
  expect(teachingLearnerFocus(value, courseId, null, false))
    .toMatchObject({ requirementKey: "prove", activityKind: "targeted_explain" });
});

it("does not borrow another course's observations or turn unavailable evidence into a diagnosis", () => {
  const value = read("no");
  expect(teachingLearnerFocus(value, "other-course", "Linear Algebra", false)).toBeNull();
  const sources = { ...value.sources, courses: value.sources.courses.map(course => ({ ...course, evidenceStatus: "unavailable" as const })) };
  expect(teachingLearnerFocus({ ...value, sources }, courseId, "Linear Algebra", false)).toBeNull();
});

it("captures the goal strategy and one bounded prerequisite while preserving the original skill and error", () => {
  const value = read("no");
  const source = value.sources.courses[0]!;
  source.goal = { targetDate: "2026-10-20", kind: "final-exam", weeklyMinutes: 300, learningMode: "auto", priority: 4 };
  source.knowledgeNodes = [{ id: "33333333-3333-4333-8333-333333333333", title: "Arithmetic", prerequisiteIds: [] },
    { id: "44444444-4444-4444-8444-444444444444", title: "Linear Algebra", prerequisiteIds: ["33333333-3333-4333-8333-333333333333"] }];
  source.observations = [...source.observations, { ...source.observations[0]!, id: "55555555-5555-4555-8555-555555555555", skillLabel: "Arithmetic" }];
  const now = new Date("2026-10-16T12:00:00Z");
  const focus = teachingLearnerFocus(value, courseId, "Linear Algebra", false, undefined, now);
  expect(focus).toMatchObject({ skillLabel: "Linear Algebra", focusObservationId: source.observations[0]!.id,
    goalContext: { mode: "exam", daysRemaining: 4, priority: 4 },
    prerequisiteRepair: { skillLabel: "Arithmetic", returnToSkillLabel: "Linear Algebra", maxMinutes: 5 } });
  source.goal = { ...source.goal, learningMode: "understand" };
  expect(teachingLearnerFocus(value, courseId, "Linear Algebra", true, undefined, now)).toMatchObject({
    activityKind: "full_explain", goalContext: { mode: "understand" }, prerequisiteRepair: { maxMinutes: 10 },
  });
});

it("keeps a near-term interest goal in understanding mode instead of inferring an exam", () => {
  const value = read("no");
  value.sources.courses[0]!.goal = { targetDate: "2026-10-20", kind: "interest", weeklyMinutes: 300, learningMode: "auto", priority: 4 };
  expect(teachingLearnerFocus(value, courseId, "Linear Algebra", false, undefined, new Date("2026-10-16T12:00:00Z")))
    .toMatchObject({ activityKind: "targeted_explain", focusObservationId: "22222222-2222-4222-8222-222222222222",
      goalContext: { mode: "understand", daysRemaining: 4, priority: 4, prerequisiteBudgetMinutes: 10 } });
});

it("keeps local-day goal timing separate from elapsed prerequisite evidence age", () => {
  const value = read("no");
  value.sources.date = "2026-10-17";
  const source = value.sources.courses[0]!;
  source.goal = { targetDate: "2026-10-20", weeklyMinutes: 300 };
  source.knowledgeNodes = [{ id: "a", title: "Arithmetic", prerequisiteIds: [] }, { id: "b", title: "Linear Algebra", prerequisiteIds: ["a"] }];
  source.observations = [...source.observations, { ...source.observations[0]!, id: "pre", skillLabel: "Arithmetic", attemptedAt: "2026-10-18T03:00:00Z" }];
  expect(teachingLearnerFocus(value, courseId, "Linear Algebra", false, undefined, new Date("2026-10-17T20:05:00-07:00")))
    .toMatchObject({ goalContext: { daysRemaining: 3 }, prerequisiteRepair: { skillLabel: "Arithmetic" } });
});

it("does not insert a prerequisite detour when the current target already has independent evidence", () => {
  const value = read("yes");
  const source = value.sources.courses[0]!;
  source.knowledgeNodes = [{ id: "a", title: "Arithmetic", prerequisiteIds: [] }, { id: "b", title: "Linear Algebra", prerequisiteIds: ["a"] }];
  source.observations = [...source.observations, { ...source.observations[0]!, id: "pre", skillLabel: "Arithmetic", verifiedCorrect: "no" }];
  expect(teachingLearnerFocus(value, courseId, "Linear Algebra", false)).toMatchObject({ activityKind: "transfer_check" });
  expect(teachingLearnerFocus(value, courseId, "Linear Algebra", false)?.prerequisiteRepair).toBeUndefined();
});

it("passes only current, same-requirement historical errors to teaching", () => {
  const value = read("no"), source = value.sources.courses[0]!;
  const base = source.observations[0]!;
  const error = { observationId: base.id, label: "符号", feedback: "漏掉负号", source: "ai_feedback" as const };
  source.observations = [{ ...base, errors: [error] },
    { ...base, id: courseId, requirementKey: "another", errors: [{ ...error, feedback: "其他要求" }] },
    { ...base, id: courseId, usableForCurrentVersion: "no", errors: [{ ...error, feedback: "旧材料" }] }];
  expect(teachingLearnerFocus(value, courseId, "Linear Algebra", false)?.recentErrors).toEqual([error]);
});
