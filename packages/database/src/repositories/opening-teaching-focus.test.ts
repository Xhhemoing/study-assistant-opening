import type { Sql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeachingLearnerFocus } from "@aistudy/contracts";
import { buildDecisionInput, nextLearningStep, toSnapshotEvidence, type CourseEvidence } from "@aistudy/domain";
import { learningObservation, qualifiedInput } from "../../../domain/src/opening/learning-summary-fixtures";
import { readOpeningTeachingCompilerFocus } from "./opening-teaching-focus";
import { readOpeningCourseEvidence } from "./opening-learning-read";

vi.mock("./opening-learning-read", () => ({ readOpeningCourseEvidence: vi.fn() }));
const scope = { workspaceId: learningObservation.workspaceId, ownerUserId: "22222222-2222-4222-8222-222222222222" };
const oldId = "44444444-4444-4444-8444-444444444441";
const newId = "44444444-4444-4444-8444-444444444442";
const focus: TeachingLearnerFocus = { skillLabel: "fractions", activityKind: "transfer_check", reasonCode: "independent",
  focusObservationId: null, recentAssistance: [], strategyVersion: "adaptive-1" };
function evidence(): CourseEvidence {
  // A legacy null-requirement summary requires every row to be independent;
  // canonical decision status uses the latest usable row instead.
  return { observations: [oldId, newId].map(id => ({ ...learningObservation, id })),
    evidenceContexts: Object.fromEntries([oldId, newId].map((id, index) => [id, {
      observation: { ...qualifiedInput.observation, requirementKey: null, submittedAt: 300 + index,
        assistance: index === 0 ? "unknown" : "independent" },
      context: { ...qualifiedInput.context, ...(index === 0 ? { helpHistory: { complete: false, exposures: [] } } : {}) },
    }])) };
}
function sqlFor(stored: TeachingLearnerFocus, stem?: string) {
  const activity = [{ course_id: learningObservation.courseId, goal_json: { learnerFocus: stored } }];
  const sql = vi.fn().mockResolvedValue(activity);
  // Query order in readOpeningTeachingCompilerFocus: the activity row first, then
  // (route branch, no prerequisite repair) withFocusAttempt's stem_snapshot lookup.
  return stem === undefined ? sql : sql.mockResolvedValueOnce(activity).mockResolvedValueOnce([{ stem_snapshot: stem }]);
}
beforeEach(() => vi.clearAllMocks());
describe("compiler focus canonical decision input with independent admission guards", () => {
  it("uses latest usable independent status, matching agenda/span canonical input without inventing legacy identity", async () => {
    const facts = evidence();
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(facts);
    const projected = toSnapshotEvidence(facts, new Date());
    expect(projected.summaries[0]?.status).toBe("needs_check");
    const expected = { activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null };
    expect(nextLearningStep(buildDecisionInput({ observations: projected.observations, wantsFullExplanation: false }))).toEqual(expected);
    const result = await readOpeningTeachingCompilerFocus(sqlFor(focus) as unknown as Sql, scope, newId);
    expect(result.learnerFocus).toMatchObject(expected);
    expect(result.learnerFocus?.recentAssistance).toEqual(["independent", "unknown"]);
    expect(result).not.toHaveProperty("focusAttempt");
  });

  it.each(["missing", "unavailable", "correct", "requirement mismatch"])("does not bypass the stored focus guard for %s evidence", async invalid => {
    const facts = evidence();
    const captured = facts.evidenceContexts[oldId]!;
    if (invalid !== "correct") {
      captured.observation = { ...captured.observation, outcome: "incorrect" };
      captured.context = { ...captured.context, referenceCheck: { ...captured.context.referenceCheck!, outcome: "incorrect" } };
    }
    if (invalid === "missing") delete facts.evidenceContexts[oldId];
    if (invalid === "unavailable") captured.context = { ...captured.context, version: { applicability: "unavailable" } };
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(facts);
    const stored = { ...focus, activityKind: "targeted_explain" as const, reasonCode: "verified_incorrect", focusObservationId: oldId,
      ...(invalid === "requirement mismatch" ? { requirementKey: "different" } : {}) };
    const sql = sqlFor(stored);
    expect(await readOpeningTeachingCompilerFocus(sql as unknown as Sql, scope, newId)).toEqual({});
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("retains the stored snapshot reason when activity and focus ID stay unchanged", async () => {
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(evidence());
    const stored = { ...focus, reasonCode: "correct_needs_independent_check" };
    const result = await readOpeningTeachingCompilerFocus(sqlFor(stored) as unknown as Sql, scope, newId);
    expect(result.learnerFocus).toEqual({ ...stored, recentAssistance: ["independent", "unknown"] });
  });

  it("uses the latest usable row but keeps ambiguous requirement groups rejected", async () => {
    const facts = evidence();
    facts.evidenceContexts[newId]!.context = { ...qualifiedInput.context, version: { applicability: "unavailable" } };
    facts.evidenceContexts[oldId]!.observation.assistance = "independent";
    facts.evidenceContexts[oldId]!.context = qualifiedInput.context;
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(facts);
    expect((await readOpeningTeachingCompilerFocus(sqlFor(focus) as unknown as Sql, scope, newId)).learnerFocus)
      .toMatchObject({ activityKind: "transfer_check", reasonCode: "independent", recentAssistance: ["independent"] });
    facts.evidenceContexts[newId]!.observation.requirementKey = "different";
    expect(await readOpeningTeachingCompilerFocus(sqlFor(focus) as unknown as Sql, scope, newId)).toEqual({});
  });

  it("refreshes a still-qualified incorrect focus after a newer independent success", async () => {
    const facts = evidence(), captured = facts.evidenceContexts[oldId]!;
    captured.observation = { ...captured.observation, outcome: "incorrect" };
    captured.context = { ...captured.context, referenceCheck: { ...captured.context.referenceCheck!, outcome: "incorrect" } };
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(facts);
    const stored = { ...focus, activityKind: "targeted_explain" as const, reasonCode: "verified_incorrect", focusObservationId: oldId };
    const result = await readOpeningTeachingCompilerFocus(sqlFor(stored) as unknown as Sql, scope, newId);
    expect(result.learnerFocus).toMatchObject({ activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null });
    expect(result).not.toHaveProperty("focusAttempt");
  });

  it("does not promote legacy facts lacking attempt/version identity into usable evidence", async () => {
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue({ observations: [{ ...learningObservation }], evidenceContexts: {} });
    expect(await readOpeningTeachingCompilerFocus(sqlFor(focus) as unknown as Sql, scope, newId)).toEqual({});
  });

  it("retains the goal snapshot but removes expired errors when no current evidence remains", async () => {
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue({ observations: [{ ...learningObservation }], evidenceContexts: {} });
    const goalContext = { mode: "exam" as const, reasonCode: "selected_exam" as const, targetDate: null, daysRemaining: null,
      priority: 3, prerequisiteBudgetMinutes: 5 };
    const stored = { ...focus, goalContext, recentErrors: [{ observationId: oldId, label: "step", feedback: "old", source: "verified_steps" as const }] };
    expect(await readOpeningTeachingCompilerFocus(sqlFor(stored) as unknown as Sql, scope, newId))
      .toEqual({ learnerFocus: { ...focus, goalContext, activityKind: "diagnose", reasonCode: "no_evidence" } });
  });

  it("keeps a course-route snapshot instead of re-deriving it from label/key evidence", async () => {
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(evidence());
    const stored = { ...focus, activityKind: "reduced_help_practice" as const, reasonCode: "route_assisted_correction",
      recentAssistance: ["hinted" as const, "independent" as const], strategyVersion: "course-route-1" };
    // The same evidence re-derives a different action for a non-route activity.
    expect((await readOpeningTeachingCompilerFocus(sqlFor({ ...stored, strategyVersion: "adaptive-1" }) as unknown as Sql, scope, newId)).learnerFocus)
      .toMatchObject({ activityKind: "transfer_check", reasonCode: "independent" });
    expect(readOpeningCourseEvidence).toHaveBeenCalledTimes(1);
    for (const activityKind of ["reduced_help_practice", "transfer_check"] as const) {
      const route = { ...stored, activityKind };
      expect(await readOpeningTeachingCompilerFocus(sqlFor(route) as unknown as Sql, scope, newId)).toEqual({ learnerFocus: route });
    }
    expect(readOpeningCourseEvidence).toHaveBeenCalledTimes(1);
  });

  it("keeps a course-route focused correction while its answer is still current and incorrect, and clears it otherwise", async () => {
    const facts = evidence(), captured = facts.evidenceContexts[oldId]!;
    captured.observation = { ...captured.observation, outcome: "incorrect" };
    captured.context = { ...captured.context, referenceCheck: { ...captured.context.referenceCheck!, outcome: "incorrect" } };
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(facts);
    const stored = { ...focus, activityKind: "targeted_explain" as const, reasonCode: "verified_incorrect", focusObservationId: oldId, strategyVersion: "course-route-1" };
    // A newer independent success refreshes non-route focus (see above) but not the route's snapshot.
    expect((await readOpeningTeachingCompilerFocus(sqlFor(stored) as unknown as Sql, scope, newId)).learnerFocus).toEqual(stored);
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(evidence());
    expect(await readOpeningTeachingCompilerFocus(sqlFor(stored) as unknown as Sql, scope, newId)).toEqual({});
    // Real route focus always carries requirementKey; a focused answer under another key is cleared.
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(facts);
    expect((await readOpeningTeachingCompilerFocus(sqlFor({ ...stored, requirementKey: null }) as unknown as Sql, scope, newId)).learnerFocus)
      .toEqual({ ...stored, requirementKey: null });
    expect(await readOpeningTeachingCompilerFocus(sqlFor({ ...stored, requirementKey: "other-requirement" }) as unknown as Sql, scope, newId)).toEqual({});
  });

  it("attaches the focused question and original answer to a course-route correction only while that answer is still incorrect", async () => {
    const itemVersionId = "88888888-8888-4888-8888-888888888881", stem = "Simplify 2/4.";
    const withItem = (facts: CourseEvidence) => ({ ...facts, observations: facts.observations.map(row => row.id === oldId ? { ...row, itemVersionId } : row) });
    const facts = withItem(evidence()), captured = facts.evidenceContexts[oldId]!;
    captured.observation = { ...captured.observation, outcome: "incorrect" };
    captured.context = { ...captured.context, referenceCheck: { ...captured.context.referenceCheck!, outcome: "incorrect" } };
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(facts);
    const stored = { ...focus, activityKind: "targeted_explain" as const, reasonCode: "verified_incorrect", focusObservationId: oldId, strategyVersion: "course-route-1" };
    const sql = sqlFor(stored, stem);
    expect(await readOpeningTeachingCompilerFocus(sql as unknown as Sql, scope, newId))
      .toEqual({ learnerFocus: stored, focusAttempt: { question: stem, answer: learningObservation.answer } });
    expect(sql).toHaveBeenCalledTimes(2);
    expect(sql.mock.calls[1]).toEqual(expect.arrayContaining([itemVersionId, learningObservation.problemId, scope.workspaceId, scope.ownerUserId]));
    // The same answer is no longer incorrect: no focus and no question/answer reach the prompt.
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(withItem(evidence()));
    const cleared = sqlFor(stored, stem);
    const result = await readOpeningTeachingCompilerFocus(cleared as unknown as Sql, scope, newId);
    expect(result).toEqual({});
    expect(result).not.toHaveProperty("focusAttempt");
    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it("clears a course-route focused answer whose requirementKey matches but whose skill label differs", async () => {
    // Pins the existing fail-closed behaviour: the focused answer must match the stored focus on
    // requirementKey AND normalized skill label, otherwise no focused answer is attached. The #231
    // review suggested scoping this by requirementKey plus the requirement binding instead; if that
    // change is made, update this case with it.
    const facts = evidence(), captured = facts.evidenceContexts[oldId]!;
    captured.observation = { ...captured.observation, outcome: "incorrect" };
    captured.context = { ...captured.context, referenceCheck: { ...captured.context.referenceCheck!, outcome: "incorrect" } };
    vi.mocked(readOpeningCourseEvidence).mockResolvedValue(facts);
    // The observation has no requirementKey, so a stored null key matches it.
    const stored = { ...focus, activityKind: "targeted_explain" as const, reasonCode: "verified_incorrect", focusObservationId: oldId,
      strategyVersion: "course-route-1", requirementKey: null };
    expect(await readOpeningTeachingCompilerFocus(sqlFor(stored) as unknown as Sql, scope, newId)).toEqual({ learnerFocus: stored });
    expect(await readOpeningTeachingCompilerFocus(sqlFor({ ...stored, skillLabel: "decimals" }) as unknown as Sql, scope, newId)).toEqual({});
  });

  it("keeps the explicit explanation snapshot without reading evidence", async () => {
    const stored = { ...focus, activityKind: "full_explain" as const, reasonCode: "requested_full" };
    expect(await readOpeningTeachingCompilerFocus(sqlFor(stored) as unknown as Sql, scope, newId)).toEqual({ learnerFocus: stored });
    expect(readOpeningCourseEvidence).not.toHaveBeenCalled();
  });
});
