import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
const m = vi.hoisted(() => ({ read: vi.fn(), observations: vi.fn(), goal: vi.fn(), create: vi.fn(), reserve: vi.fn(), retest: vi.fn(), grading: vi.fn(), capture: vi.fn(async (..._args: unknown[]) => ({})) }));
vi.mock("./opening-course-route-read", () => ({ readOpeningCourseRoute: m.read, readCourseRouteObservations: m.observations, readCourseRouteSourceChunks: vi.fn(async () => [{ id: "chunk", sourceId: "source", sourceVersion: 1, page: null }]) }));
vi.mock("./opening-course-route-retest-state", () => ({ readOpeningCourseRouteRetestOutcome: m.retest }));
vi.mock("./opening-learning-goals", () => ({ assertLearningGoalAction: m.goal, readLearningGoal: m.goal }));
vi.mock("./opening-teaching-activities", () => ({ createOpeningTeachingActivityInTransaction: m.create, mapTeachingActivity: vi.fn() }));
vi.mock("./opening-learning-capacity", () => ({ reserveOpeningLearningActivityBudget: m.reserve }));
vi.mock("./opening-course-route-decision", () => ({ captureOpeningCourseRouteDecision: m.capture }));
vi.mock("./opening-learner-state-read", () => ({ readOpeningLearnerState: vi.fn(async () => ({ sourceVersions: {}, stateVersion: "state", dataAsOf: "2026-10-27T00:00:00Z" })) }));
vi.mock("./opening-ai-grading-jobs", () => ({ readOpeningAiGradingStatusInTx: m.grading }));
vi.mock("./opening-learning-decisions", () => ({ recordOpeningLearningDecision: vi.fn() }));
vi.mock("./opening-learning-facts", () => ({ lockWorkspaceLearningHistory: vi.fn(), learningError: (code: string, message: string) => Object.assign(new Error(message), { code }) }));
import { createOpeningCourseRouteActions } from "./opening-course-route-actions";
const query = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]): Promise<Record<string, unknown>[]> => []);
const sql = Object.assign(query, { begin: async (fn: (tx: unknown) => unknown) => fn(sql), json: (value: unknown) => value }) as unknown as Sql;
const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
const ids = { goal: randomUUID(), course: randomUUID(), activity: randomUUID(), observation: randomUUID(), requirement: randomUUID(), skill: randomUUID(), target: randomUUID() };
const requirement = { id: ids.requirement, courseId: ids.course, stableSkillId: ids.skill, knowledgeNodeId: null, requirementKey: "key", title: "秩", position: 0, mandatory: true, goalIds: [], prerequisiteIds: [], sourceRefs: [{ sourceId: "source", sourceVersion: 1 }], verification: { kind: "exact", status: "ready", exerciseKeys: ["q"], rubric: null, missingReasons: [] }, revision: 1, lifecycle: "active", origin: "confirmed", approvedAt: "2026-10-27T00:00:00Z" };
const context = { goalId: ids.goal, goalRevision: 1, requirementId: ids.requirement, requirementRevision: 1, stableSkillId: ids.skill, requirementKey: "key", action: "diagnose" };
const observation = { id: ids.observation, activityId: ids.activity, requirementKey: "key", skillLabel: "秩", attemptedAt: "2026-10-27T00:00:00Z", problemId: "q", usableForCurrentVersion: "yes", verifiedCorrect: "unknown", independentAttempt: "yes", assistance: "independent", errors: [], courseRequirement: { id: ids.requirement, revision: 1, stableSkillId: ids.skill, requirementKey: "key" } };
const next = () => createOpeningCourseRouteActions(sql, { compilerEnabled: true }).next(scope, ids.course, { goalId: ids.goal, expectedGoalRevision: 1, activityId: ids.activity, expectedPathVersion: 1, observationId: ids.observation, clientKey: "next", minutes: 20 });
function setup(extra: Record<string, unknown> = {}, projected: unknown[] = [observation]) {
  query.mockImplementation(async strings => {
    const text = strings.join("?");
    if (text.includes("WHERE id=") && text.includes("opening_teaching_activities")) return [{ id: ids.activity, path_version: 1, goal_json: { courseRoute: { ...context, ...extra } } }];
    return [];
  });
  m.observations.mockResolvedValue({ projected, raw: [{ id: ids.observation, activityId: ids.activity, submittedAt: observation.attemptedAt }] });
}
beforeEach(() => {
  vi.resetAllMocks();
  m.grading.mockResolvedValue({ status: "needs_manual" });
  m.goal.mockResolvedValue({ id: ids.goal, revision: 1, courseIds: [ids.course] });
  m.read.mockResolvedValue({ scopeState: "confirmed", materials: [{ sourceId: "source", sourceVersion: 1, available: true }], requirements: [{ requirement, status: "needs_verification", observationId: ids.observation, sourcesAvailable: true, missingReasons: [] }] });
  m.create.mockImplementation(async (_tx, _scope, input) => ({ id: randomUUID(), learnerFocus: input.goalJson.learnerFocus }));
  setup();
});
it("缺少可用的当前作答时等待核对", async () => { setup({}, []); expect(await next()).toMatchObject({ kind: "choice", reason: "evidence_unknown" }); });
it("延迟复测 unknown 时等待核对", async () => { setup({ retestId: randomUUID() }); m.retest.mockResolvedValue("assisted"); expect(await next()).toMatchObject({ kind: "choice", reason: "evidence_unknown" }); expect(m.grading).not.toHaveBeenCalled(); });
it("综合检查 unknown 时等待核对", async () => { setup({ coveredRequirementIds: [ids.requirement], comprehensiveRunKey: "run-key-123" }); expect(await next()).toMatchObject({ kind: "choice", reason: "evidence_unknown" }); expect(m.grading).not.toHaveBeenCalled(); });
it("旧综合检查 unknown 时不读取批改状态", async () => { setup({ coveredRequirementIds: [ids.requirement] }); expect(await next()).toMatchObject({ kind: "choice", reason: "evidence_unknown" }); expect(m.grading).not.toHaveBeenCalled(); });
it.each(["queued", "grading"])("批改状态 %s 时等待结果", async status => { m.grading.mockResolvedValue({ status }); expect(await next()).toMatchObject({ kind: "choice", reason: "evidence_unknown" }); });
it.each(["graded", "needs_manual", "unknown_cost"])("批改状态 %s 继续选步", async status => { m.grading.mockResolvedValue({ status }); expect(await next()).toMatchObject({ kind: "ready", requirementId: ids.requirement }); expect(m.grading).toHaveBeenCalledWith(expect.anything(), scope, ids.observation); });
it("未校准的结果继续同一要求", async () => { expect(await next()).toMatchObject({ kind: "ready", requirementId: ids.requirement, action: "diagnose", activity: { learnerFocus: { reasonCode: "unverified_only" } } }); expect(m.reserve).toHaveBeenCalledTimes(1); });
it("前置题 unknown 且使用提示后回到目标要求", async () => {
  const target = { ...requirement, id: ids.target, stableSkillId: randomUUID(), requirementKey: "target", prerequisiteIds: [ids.requirement], position: 1 };
  m.read.mockResolvedValue({ scopeState: "confirmed", materials: [{ sourceId: "source", sourceVersion: 1, available: true }], requirements: [requirement, target].map(r => ({ requirement: r, status: "unobserved", sourcesAvailable: true, missingReasons: [] })) });
  setup({ action: "prerequisite", returnTo: ids.target }, [{ ...observation, assistance: "hinted", independentAttempt: "no" }]);
  expect(await next()).toMatchObject({ kind: "ready", requirementId: ids.target, action: "return" });
  expect(m.capture).toHaveBeenCalledWith(expect.anything(), scope, expect.objectContaining({ returnBasis: "uncalibrated" }));
  const { captureOpeningCourseRouteDecision } = await vi.importActual<typeof import("./opening-course-route-decision")>("./opening-course-route-decision");
  const input = m.capture.mock.calls[0]![2] as Parameters<typeof captureOpeningCourseRouteDecision>[2];
  const uncalibrated = await captureOpeningCourseRouteDecision(sql as never, scope, input);
  const verified = await captureOpeningCourseRouteDecision(sql as never, scope, { ...input, returnBasis: "verified" });
  const defaultVerified = await captureOpeningCourseRouteDecision(sql as never, scope, { ...input, returnBasis: undefined });
  expect(uncalibrated.reasonCodes).toContain("uncalibrated_prerequisite_return");
  expect(uncalibrated.reasonCodes).not.toContain("verified_prerequisite_return");
  expect(verified.reasonCodes).toContain("verified_prerequisite_return");
  expect(verified.reasonCodes).not.toContain("uncalibrated_prerequisite_return");
  expect(verified.intentVersion).toBe(defaultVerified.intentVersion);
  expect(JSON.parse(uncalibrated.intentVersion!)).toMatchObject({ returnBasis: "uncalibrated" });
});

it.each(["unknown", "verified"] as const)("前置要求 %s 后返回目标已失效时不写入", async state => {
  const projected = state === "unknown" ? [observation] : [
    { ...observation, verifiedCorrect: "yes", questionIdentity: "first", firstQuestionExposure: true },
    { ...observation, id: randomUUID(), activityId: randomUUID(), verifiedCorrect: "yes", questionIdentity: "second", firstQuestionExposure: true, attemptedAt: "2026-10-26T00:00:00Z" },
  ];
  setup({ action: "prerequisite", returnTo: ids.target }, projected);
  expect(await next()).toMatchObject({ kind: "choice", reason: "evidence_changed", requirementIds: [ids.requirement] });
  expect(m.create).not.toHaveBeenCalled();
  expect(m.reserve).not.toHaveBeenCalled();
  expect(m.capture).not.toHaveBeenCalled();
});
