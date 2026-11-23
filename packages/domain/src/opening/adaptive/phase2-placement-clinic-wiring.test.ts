import type { CourseRequirement } from "@aistudy/contracts";
import { describe, expect, it } from "vitest";
import { MAX_TOTAL_DRILLDOWN_PROBES, type DiagnosticProbeItem } from "../../diagnostic-placement";
import { REMEDY_CLINIC_TOTAL_MINUTES, type ClinicCandidateProbe } from "../../remedy-clinic";
import { courseRequirementProgress, courseRouteLearningDecision, selectCourseRouteStep } from "../course-route";
import { resolveGoalLearningContext } from "./goal-policy";
import { captureNextLearningStep, nextLearningStep } from "./next-learning-step";
import { buildAdaptivePlacement } from "./placement-bridge";
import { resolvePrerequisiteDrilldown, selectPrerequisiteRepair, type PrerequisiteDrilldownContext } from "./prerequisite-repair";
import { proposeAdaptiveTasks } from "./propose-tasks";
import { generateAdaptiveRemedyClinic } from "./remedy-clinic-bridge";
import type { NextLearningStepInput, SnapshotObservation } from "./snapshot-sources";
import { suggestionIdentity, type LearnerSnapshot } from "./types";
import { suggestionFeedbackIdentity } from "./suggestion-feedback";

const date = "2026-11-21";
const courseId = "course";
const nodes = [
  { id: "base", title: "整数", prerequisiteIds: [] },
  { id: "bridge", title: "代数式", prerequisiteIds: ["base"] },
  { id: "target", title: "不等式", prerequisiteIds: ["bridge"] },
];
const observation = (id: string, skillLabel: string, changes: Partial<SnapshotObservation> = {}): SnapshotObservation => ({
  id, skillLabel, attemptedAt: "2026-11-21T11:00:00Z", problemId: id, verifiedCorrect: "yes",
  usableForCurrentVersion: "yes", independentAttempt: "yes", assistance: "independent", ...changes,
});
const requirement = (id: string, title: string, knowledgeNodeId: string | null, prerequisiteIds: string[] = []): CourseRequirement => ({
  id, stableSkillId: `stable-${id}`, knowledgeNodeId, courseId, title, prerequisiteIds, requirementKey: id,
  position: 0, mandatory: true, goalIds: [], sourceRefs: [{ sourceId: id, sourceVersion: 1 }],
  verification: { kind: "exact", status: "ready", exerciseKeys: [], rubric: null, missingReasons: [] },
  origin: "syllabus", approvedAt: null, lifecycle: "active", revision: 1,
});
const noEvidence: NextLearningStepInput = { status: "unobserved", observations: [], wantsFullExplanation: false };

describe("Opening placement uses qualified evidence for routing", () => {
  const foundational = requirement("foundation", "整数", "base");
  const advanced = requirement("advanced", "不等式", "target");
  const requirements = [foundational, advanced];
  const observations = ["correct-1", "correct-2"].map(id => observation(id, "题目原标签", { requirementKey: advanced.requirementKey }));
  const place = (rows: readonly SnapshotObservation[]) => buildAdaptivePlacement({
    knowledgeNodes: nodes, requirements, observations: rows,
    skillMetadataById: new Map([["base", { chapterId: "fundamentals", syllabusWeight: 0.25 }]]),
  })!;

  it("preserves an inferred skill's holdout requirement without upgrading course progress", () => {
    const { placementRoutesByNodeId, placementRoutesByRequirementId } = place(observations);
    const placementRoute = placementRoutesByNodeId.get("base")!;
    expect(placementRoute).toMatchObject({
      route: "inferred_skip_candidate", chapterId: "fundamentals", countsTowardMastery: false,
      verificationStatus: "unverified_inferred", holdoutVerificationRequired: true, delayedCheckAfterHours: 72,
    });
    expect(captureNextLearningStep({ ...noEvidence, placementRoute })).toMatchObject({
      decision: {
        activityKind: "transfer_check", reasonCode: "correct_needs_independent_check",
        placementRoute: "inferred_skip_candidate", holdoutVerificationRequired: true,
      },
      candidates: [{ eligible: false }, { eligible: true, reasonCodes: ["placement_inferred_skip_holdout_check"], evidenceRefs: [] }],
    });
    expect(courseRouteLearningDecision([], { placementRoute })).toEqual(nextLearningStep({ ...noEvidence, placementRoute }));

    const options = { placementRoutes: placementRoutesByRequirementId };
    const available = courseRequirementProgress(requirements, observations, new Map([["foundation", 1], ["advanced", 1]]));
    expect(available[0]).toMatchObject({ status: "unobserved", sourcesAvailable: true });
    expect(selectCourseRouteStep(available, foundational.id)?.action).toBe("diagnose");
    expect(selectCourseRouteStep(available, foundational.id, options)?.action).toBe("transfer_check");
    const blocked = courseRequirementProgress(requirements, [], new Map([["foundation", 2]]));
    expect(blocked[0]).toMatchObject({ status: "blocked", sourcesAvailable: false });
    expect(selectCourseRouteStep(blocked, foundational.id, options)?.action).toBe("diagnose");
  });

  it("filters ineligible attempts, accepts verified failures, and deduplicates independent observations", () => {
    const noise = [
      observation("hint", "整数", { assistance: "hinted", verifiedCorrect: "no" }),
      observation("reveal", "整数", { assistance: "revealed", verifiedCorrect: "no" }),
      observation("unknown", "整数", { verifiedCorrect: "unknown" }),
      observation("not-independent", "整数", { independentAttempt: "no" }),
      observation("stale", "整数", { usableForCurrentVersion: "no" }),
      observation("withdrawn", "整数", { usableForCurrentVersion: undefined }),
      observation("unbound-requirement", "整数", { requirementKey: "unknown-key" }),
    ];
    expect(place([...noise, ...observations, observations[0]!])).toEqual(place([...observations].reverse()));
    const failed = place([...observations, observation("failure", "整数", { verifiedCorrect: "no" })]);
    expect(failed.snapshot.consumedProbeObservationIds).toEqual(["correct-1", "correct-2", "failure"]);
    expect(failed.placementRoutesByNodeId.get("base")!.masteryProbability)
      .toBeLessThan(place(observations).placementRoutesByNodeId.get("base")!.masteryProbability);
  });

  it("uses explicit requirement edges when knowledge nodes are absent", () => {
    const requirements = [requirement("foundation", "整数", null), requirement("advanced", "不等式", null, ["foundation"])];
    const result = buildAdaptivePlacement({ requirements, observations })!;
    expect(result.snapshot.prerequisitesBySkill["stable-advanced"]).toEqual(["stable-foundation"]);
    expect(result.placementRoutesByRequirementId.get("foundation")?.route).toBe("inferred_skip_candidate");
  });

  it("handles decomposed and bounded graphs and returns null for cycles", () => {
    const independent = Array.from({ length: 15 }, (_, i) => ({ id: `independent-${i}`, title: `Independent ${i}`, prerequisiteIds: [] }));
    const large = Array.from({ length: 16 }, (_, i) => ({ id: `leaf-${i}`, title: `Leaf ${i}`, prerequisiteIds: ["base"] }));
    const evidence = [observation("independent-correct", "Independent 0"), observation("leaf-correct", "Leaf 0")];
    expect(buildAdaptivePlacement({ knowledgeNodes: independent, observations: evidence })?.snapshot.approximationMode)
      .toBe("component_decomposed");
    const bounded = buildAdaptivePlacement({ knowledgeNodes: [...nodes, ...independent, ...large], observations: evidence })!;
    expect(bounded.snapshot.approximationMode).toBe("bounded_component_envelope");
    expect(bounded.placementRoutesByNodeId.size).toBe(nodes.length + independent.length + large.length);
    expect(bounded.snapshot.consumedProbeObservationIds).toEqual(["independent-correct", "leaf-correct"]);
    expect(buildAdaptivePlacement({
      knowledgeNodes: [{ ...nodes[0]!, prerequisiteIds: ["target"] }, ...nodes.slice(1)], observations: [],
    })).toBeNull();
  });

  it("keeps explicit phases and current direct observations ahead of a placement inference", () => {
    const placementRoute = place(observations).placementRoutesByNodeId.get("base")!;
    expect(nextLearningStep({ ...noEvidence, placementRoute, wantsFullExplanation: true }).activityKind).toBe("full_explain");
    expect(nextLearningStep({ ...noEvidence, placementRoute, learningPhase: "consolidate" }).activityKind).toBe("reduced_help_practice");
    expect(nextLearningStep({ ...noEvidence, placementRoute, observations: [observation("incorrect", "整数", { verifiedCorrect: "no" })] }))
      .toMatchObject({ activityKind: "targeted_explain", focusObservationId: "incorrect" });
  });
});

describe("bounded prerequisite drilldown", () => {
  const probe = (itemId: string, noise: number): DiagnosticProbeItem => ({
    itemId, familyId: itemId, chapterId: "opening", requiredSkillIds: ["base"], slip: noise, guess: noise, estimatedSeconds: 30,
  });
  const probePool = [probe("less-informative", 0.4), probe("best", 0.05), probe("second", 0.1)];
  const originalContext = { originalAttemptId: "attempt", originalItemId: "original", frozenDraftText: "x=", frozenCursorOffset: 2, startedAtMs: 0 };
  const response = (itemId: string, correct: boolean) => ({ observationId: `response-${itemId}`, itemId, correct, channel: "unassisted" as const });
  const input = {
    targetSkillLabel: "不等式", knowledgeNodes: nodes, goalContext: resolveGoalLearningContext(null, date),
    observations: [observation("old-prerequisite-error", "代数式", { verifiedCorrect: "no" })],
    now: new Date("2026-11-21T12:00:00Z"),
  };
  const resolve = (observations: PrerequisiteDrilldownContext["observations"]) =>
    resolvePrerequisiteDrilldown({ ...input, drilldown: { probePool, observations, originalContext } })!;

  it("returns the max-information probe and stops after two responses", () => {
    const first = resolve([]);
    expect(first).toMatchObject({ snapshot: { status: "probing", probesAdministered: 0 }, nextProbe: { itemId: "best" }, prerequisiteRepair: null });
    expect(resolve([response("best", false)])).toMatchObject({
      snapshot: { status: "probing", probesAdministered: 1 }, nextProbe: { itemId: "second" }, prerequisiteRepair: null,
    });
    const observations = [response("best", false), response("second", false), response("less-informative", true)];
    const repaired = resolve(observations);
    expect(repaired).toMatchObject({
      snapshot: { status: "repair_plan_ready", probesAdministered: MAX_TOTAL_DRILLDOWN_PROBES, confirmedDeficitSkillIds: ["base"] },
      nextProbe: null, prerequisiteRepair: { nodeId: "base", targetNodeId: "target", maxMinutes: 10 },
    });
    expect(selectPrerequisiteRepair({ ...input, drilldown: { probePool, observations, originalContext } })).toEqual(repaired.prerequisiteRepair);
  });

  it("restores the original attempt without following a legacy label-based detour", () => {
    const observations = [response("best", true), response("second", true)];
    const { snapshot, nextProbe } = resolve(observations);
    expect(snapshot).toMatchObject({ status: "restore_original_attempt", rootCause: "integration_step_coordination", restoreContext: originalContext });
    expect(nextProbe).toBeNull();
    expect(selectPrerequisiteRepair(input)?.nodeId).toBe("bridge");
    expect(selectPrerequisiteRepair({ ...input, drilldown: { probePool, observations, originalContext } })).toBeNull();
    const decision = captureNextLearningStep({ ...noEvidence, observations: [observation("original-error", "不等式", { verifiedCorrect: "no" })], drilldownSnapshot: snapshot });
    expect(decision.decision).toEqual({ activityKind: "targeted_explain", reasonCode: "verified_incorrect", focusObservationId: "original-error" });
    expect(decision.candidates.at(-1)?.reasonCodes).toEqual(["drilldown_integration_step_restore"]);
    expect(nextLearningStep({ ...noEvidence, drilldownSnapshot: snapshot, learningPhase: "new_learning" }).activityKind).toBe("full_explain");
    const insufficient = { probePool: [], observations: [], originalContext };
    expect(resolvePrerequisiteDrilldown({ ...input, drilldown: insufficient })?.snapshot.rootCause).toBe("insufficient_diagnostic_evidence");
    expect(selectPrerequisiteRepair({ ...input, drilldown: insufficient })).toBeNull();
  });
});

const skillLabel = "移项";
const requirementKey = "move-term";
const ruleId = "negative_sign_flip";
const clinicFixture = () => {
  const activeSourcesMap = new Map([["chapter-a", 1], ["chapter-b", 1], ["probes", 1]]);
  const candidateProbes: ClinicCandidateProbe<number, string>[] = [3, 5].map(n => ({
    probeId: `p${n}`, requirementKey, prompt: `给定 -x ≤ ${n}，求 x 的范围。`, targetMisconceptionId: ruleId,
    input: n, correctModel: { id: "correct", label: "正确", role: "correct", predict: input => `x ≥ ${-input}` },
    hypotheses: [{ id: ruleId, label: "符号方向错误", role: "misconception",
      description: "除以负数后仍沿用原不等号。", predict: input => `x ≤ ${-input}` }],
    observableKey: value => value, parseResponse: raw => typeof raw === "string" ? raw : null,
    sourceRefs: [{ sourceId: "probes", sourceVersion: 1 }],
  }));
  const candidate = generateAdaptiveRemedyClinic({
    learnerId: "learner", courseId, ruleId, currentPrivacyEpoch: 1, activeSourcesMap, candidateProbes,
    verifyRuleViolation: attempt => attempt.excerpt.includes("反向错误"),
    attempts: ["chapter-a", "chapter-a", "chapter-b"].map((chapterId, i) => ({
      attemptId: `attempt-${i}`, rootAttemptId: `root-${i}`, learnerId: "learner", courseId, ruleId, chapterId,
      localDate: i === 2 ? date : "2026-11-20", assisted: false, privacyEpoch: 1,
      excerpt: `反向错误 ${i}`, invariantSummary: "两边同乘负数时不等号反向。",
      sourceRefs: [{ sourceId: chapterId, sourceVersion: 1 }],
    })),
  }, { skillLabel, requirementKey });
  expect(candidate?.clinic.steps.map(step => step.durationMinutes)).toEqual([4, 3, 7]);
  return candidate!;
};
const weakSkill = (label: string, key?: string) => ({
  skillLabel: label, requirementKey: key, status: "needs_review" as const, lastObservedAt: null, recentAssistance: [],
});
const snapshot: LearnerSnapshot = {
  date, timeZone: "UTC", dueCardCount: 0, plannerHistory: [],
  courses: [{ courseId, title: "数学", goal: null, minutesThisWeek: 0, skills: [weakSkill(skillLabel, requirementKey), weakSkill("因式分解")],
    nextSkills: [], hasUsableMaterials: true }],
};
const options = { autonomy: "copilot" as const, capacityMinutes: 100, committedMinutes: 0, pendingTasks: [], idFor: (key: string) => key };

describe("adaptive clinic suggestions", () => {
  it("schedules one intact clinic before ordinary weaknesses with the existing suggestion identity", () => {
    const clinic = clinicFixture();
    const suggestions = proposeAdaptiveTasks(snapshot, { ...options, remedyClinics: [clinic, clinic] }).suggestions;
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toMatchObject({
      key: `planner:${date}:${suggestionIdentity("weak_skill", courseId, skillLabel, requirementKey)}`,
      title: "数学 · 移项 跨章错因诊所", minutes: REMEDY_CLINIC_TOTAL_MINUTES, kind: "weak_skill", reasonCode: "weak_skill",
    });
    expect(suggestions[0]!.reason).toMatch(/2 章、2 天的 3 次.*4 分钟.*3 分钟.*7 分钟/);
    expect(suggestions[1]).toMatchObject({ skillLabel: "因式分解", minutes: 25 });
  });

  it("keeps clinics ahead of ordinary weak skills at equal goal priority even when the ordinary course is behind", () => {
    const behind = { ...snapshot.courses[0]!, courseId: "behind", skills: [weakSkill("向量")],
      goal: { targetDate: null, weeklyMinutes: 100 } };
    const plan = { ...options, remedyClinics: [clinicFixture()] };
    const samePriority = { ...snapshot, courses: [...snapshot.courses, behind] };
    expect(proposeAdaptiveTasks(samePriority, plan).suggestions[0]).toMatchObject({ courseId, minutes: 14 });
    const higherPriority = { ...snapshot, courses: [...snapshot.courses, { ...behind, goal: { ...behind.goal, priority: 1 } }] };
    expect(proposeAdaptiveTasks(higherPriority, plan).suggestions[0]).toMatchObject({ courseId: "behind", minutes: 25 });
  });

  it("revalidates source revocation, versions, probes, and privacy epochs at planning time", () => {
    const clinic = clinicFixture();
    const baseline = proposeAdaptiveTasks(snapshot, options);
    for (const candidate of [
      { ...clinic, activeSources: new Map([["chapter-a", 1], ["probes", 1]]) },
      { ...clinic, activeSources: new Map([["chapter-a", 1], ["chapter-b", 2], ["probes", 1]]) },
      { ...clinic, activeSources: new Map([["chapter-a", 1], ["chapter-b", 1]]) },
      { ...clinic, currentPrivacyEpoch: clinic.currentPrivacyEpoch + 1 },
    ]) expect(proposeAdaptiveTasks(snapshot, { ...options, remedyClinics: [candidate] })).toEqual(baseline);
  });

  it("respects proposal controls and skips clinics that would be shortened", () => {
    const clinic = clinicFixture();
    const course = snapshot.courses[0]!;
    const exam = { ...snapshot, courses: [{ ...course, goal: { kind: "final-exam" as const, targetDate: "2026-11-23", weeklyMinutes: 0 }, skills: [] }] };
    const plan = { ...options, remedyClinics: [clinic] };
    const identity = suggestionIdentity("weak_skill", courseId, skillLabel, requirementKey);
    const suppression = suggestionFeedbackIdentity({ kind: "weak_skill", courseId, skillLabel, requirementKey });
    expect(proposeAdaptiveTasks(exam, { ...plan, capacityMinutes: 17 }).suggestions).toEqual([]);
    expect(proposeAdaptiveTasks(exam, { ...plan, capacityMinutes: 18 }).suggestions[0]?.minutes).toBe(14);
    expect(proposeAdaptiveTasks(exam, { ...plan, maxContinuousMinutesForCourse: () => 13 }).suggestions).toEqual([]);
    expect(proposeAdaptiveTasks(exam, { ...plan, autonomy: "manual" }).suggestions).toEqual([]);
    expect(proposeAdaptiveTasks(exam, { ...plan, suppressedSuggestionIdentities: [suppression] }).suggestions).toEqual([]);
    expect(proposeAdaptiveTasks(exam, { ...plan, pendingTasks: [
      { id: "pending", title: "移项", courseId, skillLabel, requirementKey, status: "pending", minutes: 15, dueAt: null, priority: 1 },
    ] }).suggestions).toEqual([]);
    expect(proposeAdaptiveTasks({ ...exam, courses: [{ ...course, skills: [], hasUsableMaterials: false }] }, plan).suggestions).toEqual([]);
    expect(proposeAdaptiveTasks({ ...exam, plannerHistory: [{ date, identity, status: "done" }] }, plan).suggestions).toEqual([]);
    const skipped = { ...exam, plannerHistory: ["2026-11-20", "2026-11-19"].map(day => ({ date: day, identity, status: "skipped" as const })) };
    expect(proposeAdaptiveTasks(skipped, plan).suggestions).toEqual([]);
    expect(proposeAdaptiveTasks({ ...skipped, courses: snapshot.courses }, plan).suggestions)
      .toContainEqual(expect.objectContaining({ minutes: 13, skillLabel, reasonCode: "repeatedly_skipped" }));
  });
});

it("preserves serialized legacy decisions, receipts and suggestions when the new inputs are undefined", () => {
  const expected = {
    decision: { activityKind: "diagnose", focusObservationId: null, reasonCode: "no_evidence" },
    candidates: [
      { action: "full_explain", eligible: false, reasonCodes: ["not_requested_full"], evidenceRefs: [] },
      { action: "diagnose", eligible: true, reasonCodes: ["no_evidence"], evidenceRefs: [] },
    ],
  };
  expect(JSON.stringify(captureNextLearningStep(noEvidence))).toBe(JSON.stringify(expected));
  expect(JSON.stringify(captureNextLearningStep({ ...noEvidence, drilldownSnapshot: undefined, placementRoute: undefined }))).toBe(JSON.stringify(expected));
  expect(JSON.stringify(courseRouteLearningDecision([]))).toBe(JSON.stringify(expected.decision));
  expect(JSON.stringify(proposeAdaptiveTasks(snapshot, { ...options, remedyClinics: undefined })))
    .toBe(JSON.stringify(proposeAdaptiveTasks(snapshot, options)));
});
