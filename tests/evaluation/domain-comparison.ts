/*
 * Portable paired functional assessment. Copy unchanged to both versions at:
 * packages/domain/src/opening/adaptive/version-comparison.test.ts
 * Run: AB_RESULT_PATH=/absolute/result.json npx vitest run --project unit packages/domain/src/opening/adaptive/version-comparison.test.ts
 * This is a deliberately selected synthetic regression set, not a random sample
 * of users, a learning experiment, a browser test, or an end-to-end availability SLA.
 */
import { afterAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import {
  ADAPTIVE_STRATEGY_VERSION,
  assembleLearnerSnapshot,
  nextLearningStep,
  proposeAdaptiveTasks,
  suggestionIdentity,
  type LearnerSnapshot,
  type LearnerSnapshotSources,
  type NextLearningStepInput,
  type SnapshotCourseSource,
  type SnapshotObservation,
  type SnapshotSkillSummary,
} from "@aistudy/domain";

const courseId = "00000000-0000-4000-8000-000000000001";
const date = "2026-10-21";
type Requirement = { requirementKey?: string | null };
type ObservationFixture = Partial<SnapshotObservation> & Requirement & { usableForCurrentVersion?: "yes" | "no" | "unknown" };
type SummaryFixture = Partial<SnapshotSkillSummary> & Requirement;
const observation = (overrides: ObservationFixture = {}): SnapshotObservation => ({
  id: "attempt-1", skillLabel: "极限", attemptedAt: "2026-10-21T10:00:00Z",
  assistance: "independent", verifiedCorrect: "yes", independentAttempt: "yes", problemId: "problem-1",
  usableForCurrentVersion: "yes", ...overrides,
} as SnapshotObservation);
const summary = (overrides: SummaryFixture = {}): SnapshotSkillSummary => ({
  skillLabel: "极限", status: "needs_check", lastObservedAt: null, ...overrides,
} as SnapshotSkillSummary);
const course = (overrides: Partial<SnapshotCourseSource> = {}): SnapshotCourseSource => ({
  courseId, title: "高等数学", goal: null, hasUsableMaterials: true, evidenceStatus: "available",
  summaries: [], observations: [], knowledgeNodes: [], ...overrides,
});
const assemble = (overrides: Partial<SnapshotCourseSource> = {}): LearnerSnapshot => assembleLearnerSnapshot({
  date, timeZone: "America/Los_Angeles", courses: [course(overrides)], tasks: [], dueCardCount: 0,
} satisfies LearnerSnapshotSources);
const options = {
  autonomy: "copilot" as const, capacityMinutes: 180, committedMinutes: 0, pendingTasks: [], idFor: (key: string) => key,
};
const propose = (snapshot: LearnerSnapshot, overrides: Partial<Parameters<typeof proposeAdaptiveTasks>[1]> = {}) =>
  proposeAdaptiveTasks(snapshot, { ...options, ...overrides }).suggestions;
const projectSkills = (snapshot: LearnerSnapshot) => snapshot.courses[0]!.skills.map(skill => ({
  requirement: (skill as typeof skill & Requirement).requirementKey ?? null,
  status: skill.status,
  assistance: [...skill.recentAssistance],
})).sort((a, b) => String(a.requirement).localeCompare(String(b.requirement)));
const requirements = (rows: ReturnType<typeof propose>) => rows.map(row =>
  (row as typeof row & Requirement).requirementKey ?? null).sort();
const next = (overrides: Partial<NextLearningStepInput> = {}) => nextLearningStep({
  status: "needs_check", observations: [], wantsFullExplanation: false, ...overrides,
});
const pending = (requirementKey: string | null) => ({
  id: "00000000-0000-4000-8000-000000000002", title: "极限练习", minutes: 25, dueAt: null,
  priority: 1, status: "pending" as const, courseId, skillLabel: "极限", requirementKey,
});
const weak = (requirementKeys: string[]) => assemble({
  summaries: requirementKeys.map(requirementKey => summary({ requirementKey, status: "needs_review" })),
});
const legacyIdentity = suggestionIdentity("weak_skill", courseId, "极限");
const skipped = ["2026-10-20", "2026-10-19", "2026-10-18"].map(day => ({
  date: day, identity: legacyIdentity, status: "skipped" as const,
}));

type Case = { id: string; kind: "targeted_regression" | "compatibility_control"; name: string; oracle: string; expected: unknown; run: () => unknown };
const cases: Case[] = [
  {
    id: "D01", kind: "targeted_regression", name: "same label keeps two requirement states",
    oracle: "An independent calculation and an incorrect proof are different learning targets; neither state may replace the other.",
    expected: [
      { requirement: "calculate", status: "observed_independent", assistance: ["independent"] },
      { requirement: "prove", status: "needs_review", assistance: ["independent"] },
    ],
    run: () => projectSkills(assemble({
      summaries: [summary({ requirementKey: "calculate", status: "observed_independent" }), summary({ requirementKey: "prove" })],
      observations: [observation({ requirementKey: "calculate" }), observation({ id: "proof-error", requirementKey: "prove", verifiedCorrect: "no", attemptedAt: "2026-10-20T10:00:00Z" })],
    })),
  },
  {
    id: "D02", kind: "targeted_regression", name: "recommend only the incorrect requirement",
    oracle: "The recommended task must name proof, even though a later calculation is correct.", expected: ["prove"],
    run: () => requirements(propose(assemble({
      summaries: [summary({ requirementKey: "calculate", status: "observed_independent" }), summary({ requirementKey: "prove" })],
      observations: [observation({ requirementKey: "calculate" }), observation({ id: "proof-error", requirementKey: "prove", verifiedCorrect: "no", attemptedAt: "2026-10-20T10:00:00Z" })],
    }))),
  },
  {
    id: "D03", kind: "targeted_regression", name: "pending calculation cannot suppress proof",
    oracle: "A pending calculation task does not cover the separate proof requirement.", expected: ["prove"],
    run: () => requirements(propose(weak(["prove"]), { pendingTasks: [pending("calculate")] })),
  },
  {
    id: "D04", kind: "targeted_regression", name: "two weak requirements have distinct suggestion keys",
    oracle: "Two independently actionable requirements need two distinct persistent task identities.", expected: { count: 2, distinctKeys: 2, requirements: ["calculate", "prove"] },
    run: () => { const rows = propose(weak(["calculate", "prove"])); return { count: rows.length, distinctKeys: new Set(rows.map(row => row.key)).size, requirements: requirements(rows) }; },
  },
  {
    id: "D05", kind: "targeted_regression", name: "invalidated error cannot produce current remediation",
    oracle: "A wrong answer explicitly inapplicable to the current material is retained as history, not a current weak-skill task.", expected: { status: "needs_check", suggestions: 0 },
    run: () => { const snap = assemble({ summaries: [summary()], observations: [observation({ verifiedCorrect: "no", usableForCurrentVersion: "no" })] }); return { status: snap.courses[0]!.skills[0]!.status, suggestions: propose(snap).length }; },
  },
  {
    id: "D06", kind: "targeted_regression", name: "unknown or absent qualification fails closed",
    oracle: "Neither unknown nor missing current-version qualification authorizes a remediation task.", expected: [0, 0],
    run: () => ["unknown", undefined].map(qualification => propose(assemble({ summaries: [summary()], observations: [observation({ verifiedCorrect: "no", usableForCurrentVersion: qualification as "unknown" | undefined })] })).length),
  },
  {
    id: "D07", kind: "targeted_regression", name: "invalidated hint history cannot imply current dependence",
    oracle: "Two inapplicable hinted/revealed attempts do not establish assistance dependence for the current version.", expected: { assistance: [], suggestions: 0 },
    run: () => { const snap = assemble({ summaries: [summary()], observations: [observation({ id: "old-hint", assistance: "hinted", usableForCurrentVersion: "no" }), observation({ id: "old-answer", assistance: "revealed", usableForCurrentVersion: "unknown" })] }); return { assistance: [...snap.courses[0]!.skills[0]!.recentAssistance], suggestions: propose(snap).length }; },
  },
  {
    id: "D08", kind: "targeted_regression", name: "latest valid error survives newer inapplicable correct history",
    oracle: "With newest-first inputs, choose the latest applicable wrong attempt as the teaching focus.", expected: { activityKind: "targeted_explain", focusObservationId: "valid-error", reasonCode: "verified_incorrect" },
    run: () => next({ observations: [observation({ id: "new-stale-correct", usableForCurrentVersion: "no" }), observation({ id: "valid-error", verifiedCorrect: "no", attemptedAt: "2026-10-20T10:00:00Z" })] }),
  },
  {
    id: "D09", kind: "targeted_regression", name: "stale error cannot displace current independent transfer",
    oracle: "After an independently established status, an inapplicable error does not replace transfer checking with explanation.", expected: "transfer_check",
    run: () => next({ status: "observed_independent", observations: [observation({ id: "stale-error", verifiedCorrect: "no", usableForCurrentVersion: "no" }), observation({ id: "valid-correct", attemptedAt: "2026-10-20T10:00:00Z" })] }).activityKind,
  },
  {
    id: "D10", kind: "targeted_regression", name: "stale hint majority cannot alter current teaching",
    oracle: "One current independent result plus two inapplicable hints is independent current evidence, not a current assisted majority.", expected: "transfer_check",
    run: () => next({ status: "observed_independent", observations: [observation(), observation({ id: "old-hint", assistance: "hinted", usableForCurrentVersion: "no" }), observation({ id: "old-answer", assistance: "revealed", usableForCurrentVersion: "no" })] }).activityKind,
  },
  {
    id: "D11", kind: "targeted_regression", name: "all prerequisite requirements must pass across label aliases",
    oracle: "Calculation mastery cannot unlock the dependent concept while a proof requirement for the same normalized prerequisite remains unchecked.", expected: [],
    run: () => assemble({ summaries: [summary({ skillLabel: "极限", requirementKey: "calculate", status: "observed_independent" }), summary({ skillLabel: " 极 限 ", requirementKey: "prove", status: "needs_check" })], knowledgeNodes: [{ id: "limit", title: "极限", prerequisiteIds: [] }, { id: "continuity", title: "连续", prerequisiteIds: ["limit"] }] }).courses[0]!.nextSkills,
  },
  {
    id: "C01", kind: "compatibility_control", name: "complete prerequisite requirements unlock next concept",
    oracle: "When both requirements are independent, the next concept remains available.", expected: ["连续"],
    run: () => assemble({ summaries: [summary({ requirementKey: "calculate", status: "observed_independent" }), summary({ requirementKey: "prove", status: "observed_independent" })], knowledgeNodes: [{ id: "limit", title: "极限", prerequisiteIds: [] }, { id: "continuity", title: "连续", prerequisiteIds: ["limit"] }] }).courses[0]!.nextSkills,
  },
  {
    id: "C02", kind: "compatibility_control", name: "unique legacy pending task still deduplicates",
    oracle: "A label-only pending task has one possible requirement target and must not be duplicated after upgrade.", expected: 0,
    run: () => propose(weak(["prove"]), { pendingTasks: [pending(null)] }).length,
  },
  {
    id: "D12", kind: "targeted_regression", name: "ambiguous legacy task cannot suppress both requirements",
    oracle: "A label-only task with two possible targets cannot be attributed to either; retain both explicit requirement suggestions.", expected: ["calculate", "prove"],
    run: () => requirements(propose(weak(["calculate", "prove"]), { pendingTasks: [pending(null)] })),
  },
  {
    id: "C03", kind: "compatibility_control", name: "unique legacy three-day skip still suppresses",
    oracle: "A uniquely attributable historical rejection remains respected after requirement identities are introduced.", expected: 0,
    run: () => propose({ ...weak(["prove"]), plannerHistory: skipped }).length,
  },
  {
    id: "D13", kind: "targeted_regression", name: "ambiguous legacy skip cannot reject both targets",
    oracle: "A historical label-only rejection must not be silently assigned to two distinct explicit requirements.", expected: ["calculate", "prove"],
    run: () => requirements(propose({ ...weak(["calculate", "prove"]), plannerHistory: skipped })),
  },
  {
    id: "C04", kind: "compatibility_control", name: "current verified error still selects focused explanation",
    oracle: "A current verified wrong answer remains actionable and retains its exact attempt focus.", expected: { activityKind: "targeted_explain", focusObservationId: "current-error", reasonCode: "verified_incorrect" },
    run: () => next({ observations: [observation({ id: "current-error", verifiedCorrect: "no" })] }),
  },
  {
    id: "C05", kind: "compatibility_control", name: "current assisted majority still selects reduced-help practice",
    oracle: "Current hinted/revealed correct attempts require practice with reduced assistance.", expected: "reduced_help_practice",
    run: () => next({ observations: [observation({ assistance: "hinted" }), observation({ id: "current-reveal", assistance: "revealed" })] }).activityKind,
  },
  {
    id: "C06", kind: "compatibility_control", name: "explicit full-explanation request remains highest priority",
    oracle: "The learner's explicit request for a full explanation overrides automatic error handling.", expected: "full_explain",
    run: () => next({ wantsFullExplanation: true, observations: [observation({ verifiedCorrect: "no" })] }).activityKind,
  },
  {
    id: "C07", kind: "compatibility_control", name: "manual mode, capacity and daily limit remain effective",
    oracle: "Manual mode proposes zero; committed work cannot be overbooked; at most three suggestions are emitted.", expected: { manual: 0, capacity: 0, daily: 3, plannedMinutes: 75 },
    run: () => { const snap = assemble({ summaries: ["极限", "导数", "积分", "级数"].map(skillLabel => summary({ skillLabel, status: "needs_review" })) }); const rows = propose(snap); return { manual: propose(snap, { autonomy: "manual" }).length, capacity: propose(snap, { capacityMinutes: 30, committedMinutes: 24 }).length, daily: rows.length, plannedMinutes: rows.reduce((sum, row) => sum + row.minutes, 0) }; },
  },
];

const results: { id: string; kind: Case["kind"]; name: string; oracle: string; actual: unknown; expected: unknown; pass: boolean }[] = [];
let performanceResult: unknown = null;
describe("paired adaptive usability scenarios", () => {
  for (const scenario of cases) {
    it(`${scenario.id} ${scenario.name}`, () => {
      let actual: unknown;
      try { actual = scenario.run(); } catch (error) { actual = { error: error instanceof Error ? error.message : String(error) }; }
      const result = { id: scenario.id, kind: scenario.kind, name: scenario.name, oracle: scenario.oracle, actual, expected: scenario.expected, pass: isDeepStrictEqual(actual, scenario.expected) };
      results.push(result);
      console.log(`AB_CASE_JSON ${JSON.stringify(result)}`);
      expect(actual, scenario.oracle).toEqual(scenario.expected);
    });
  }
});

// Identical, deterministic fixture and operation counts in both versions. No assertion,
// startup, import, JSON formatting or logging is inside the timed section.
it("measures the fixed pure-function workload separately from scenario outcomes", () => {
  const courseCount = 10;
  const skillLabelsPerCourse = 10;
  const requirementsPerSkill = 2;
  const observationsPerRequirement = 3;
  const perfSources: LearnerSnapshotSources = {
    date, timeZone: "America/Los_Angeles", tasks: [], dueCardCount: 8,
    courses: Array.from({ length: courseCount }, (_, courseIndex) => course({
      courseId: `performance-course-${courseIndex}`, title: `课程 ${courseIndex}`,
      summaries: Array.from({ length: skillLabelsPerCourse * requirementsPerSkill }, (_, index) => summary({
        skillLabel: `知识点 ${Math.floor(index / requirementsPerSkill)}`, requirementKey: `requirement-${index % requirementsPerSkill}`,
        status: index % 3 === 0 ? "needs_review" : index % 3 === 1 ? "observed_independent" : "needs_check",
      })),
      observations: Array.from({ length: skillLabelsPerCourse * requirementsPerSkill * observationsPerRequirement }, (_, index) => {
        const skillIndex = Math.floor(index / observationsPerRequirement);
        return observation({ id: `performance-${courseIndex}-${index}`, skillLabel: `知识点 ${Math.floor(skillIndex / requirementsPerSkill)}`,
          requirementKey: `requirement-${skillIndex % requirementsPerSkill}`, attemptedAt: `2026-10-21T10:0${index % observationsPerRequirement}:00Z`,
          verifiedCorrect: skillIndex % 3 === 0 ? "no" : "yes", usableForCurrentVersion: index % 5 === 0 ? "no" : "yes",
          assistance: index % 4 === 0 ? "hinted" : "independent" });
      }),
      knowledgeNodes: Array.from({ length: skillLabelsPerCourse + 1 }, (_, index) => ({ id: `node-${index}`, title: `知识点 ${index}`, prerequisiteIds: index > 0 ? [`node-${index - 1}`] : [] })),
    })),
  };
  const perfNextInput: NextLearningStepInput = { status: "observed_independent", wantsFullExplanation: false,
    observations: [observation(), observation({ id: "perf-stale-hint", usableForCurrentVersion: "no", assistance: "hinted" }), observation({ id: "perf-stale-reveal", usableForCurrentVersion: "no", assistance: "revealed" })] };
  let checksum = 0;
  const oneIteration = () => {
    const snapshot = assembleLearnerSnapshot(perfSources);
    const proposed = proposeAdaptiveTasks(snapshot, options);
    const step = nextLearningStep(perfNextInput);
    checksum += snapshot.courses.length + proposed.suggestions.length + step.activityKind.length;
  };
  const warmupIterations = 200;
  const batches = Number(process.env.AB_PERF_BATCHES ?? 30);
  const iterationsPerBatch = Number(process.env.AB_PERF_ITERATIONS ?? 100);
  for (let index = 0; index < warmupIterations; index += 1) oneIteration();
  const samples = Array.from({ length: batches }, (_, batch) => {
    const started = performance.now();
    for (let iteration = 0; iteration < iterationsPerBatch; iteration += 1) oneIteration();
    const elapsedMs = performance.now() - started;
    return { batch, elapsedMs, iterations: iterationsPerBatch, operations: iterationsPerBatch * 3, millisecondsPerIteration: elapsedMs / iterationsPerBatch };
  });
  performanceResult = {
    protocol: "fixed-pure-functions-v1", strategyVersion: ADAPTIVE_STRATEGY_VERSION,
    revision: process.env.AB_REVISION ?? null, sourceRoot: process.env.AB_SOURCE_ROOT ?? process.cwd(), testModuleUrl: import.meta.url,
    fixture: { courseCount, skillLabelsPerCourse, requirementsPerSkill, observationsPerRequirement, totalObservations: courseCount * skillLabelsPerCourse * requirementsPerSkill * observationsPerRequirement },
    warmupIterations, batches, iterationsPerBatch, callsPerIteration: { assembleLearnerSnapshot: 1, proposeAdaptiveTasks: 1, nextLearningStep: 1 },
    samples, checksum,
  };
  console.log(`AISTUDY_AB_PERF_JSON ${JSON.stringify(performanceResult)}`);
}, 60_000);
afterAll(() => {
  const summary = {
    protocol: "adaptive-paired-functional-v1", synthetic: true,
    strategyVersion: ADAPTIVE_STRATEGY_VERSION, revision: process.env.AB_REVISION ?? null,
    sourceRoot: process.env.AB_SOURCE_ROOT ?? process.cwd(), testModuleUrl: import.meta.url, nodeVersion: process.version,
    total: results.length, passed: results.filter(row => row.pass).length,
    targeted: { total: results.filter(row => row.kind === "targeted_regression").length, passed: results.filter(row => row.kind === "targeted_regression" && row.pass).length },
    controls: { total: results.filter(row => row.kind === "compatibility_control").length, passed: results.filter(row => row.kind === "compatibility_control" && row.pass).length },
    cases: results, performance: performanceResult,
  };
  if (process.env.AB_RESULT_PATH) writeFileSync(process.env.AB_RESULT_PATH, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`AB_SUMMARY_JSON ${JSON.stringify(summary)}`);
});
