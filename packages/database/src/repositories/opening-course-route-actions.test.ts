import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CourseRequirement, Scope } from "@aistudy/contracts";
import type { CourseRouteObservation } from "@aistudy/domain";
import type { Sql } from "postgres";

const mocks = vi.hoisted(() => ({ read: vi.fn(), observations: vi.fn(), goal: vi.fn(), create: vi.fn(), capture: vi.fn(), record: vi.fn(), reserve: vi.fn(), retestOutcome: vi.fn() }));
vi.mock("./opening-course-route-retest-state", () => ({ readOpeningCourseRouteRetestOutcome: mocks.retestOutcome }));
vi.mock("./opening-course-route-read", () => ({ readOpeningCourseRoute: mocks.read, readCourseRouteObservations: mocks.observations, readCourseRouteSourceChunks: vi.fn(async () => [{ id: "chunk", sourceId: "source", sourceVersion: 1, page: null }]) }));
vi.mock("./opening-learning-goals", () => ({ assertLearningGoalAction: mocks.goal, readLearningGoal: mocks.goal }));
vi.mock("./opening-teaching-activities", () => ({ createOpeningTeachingActivityInTransaction: mocks.create, mapTeachingActivity: vi.fn() }));
vi.mock("./opening-learning-capacity", () => ({ reserveOpeningLearningActivityBudget: mocks.reserve }));
vi.mock("./opening-course-route-decision", () => ({ captureOpeningCourseRouteDecision: mocks.capture }));
vi.mock("./opening-learning-decisions", () => ({ recordOpeningLearningDecision: mocks.record }));
vi.mock("./opening-learning-facts", () => ({ lockWorkspaceLearningHistory: vi.fn(), learningError: (code: string, message: string) => Object.assign(new Error(message), { code }) }));
import { createOpeningCourseRouteActions } from "./opening-course-route-actions";

const requirement: CourseRequirement = { id: "r", courseId: "c", stableSkillId: "s", knowledgeNodeId: null, requirementKey: "key", title: "秩", position: 0, mandatory: true,
  goalIds: [], prerequisiteIds: [], sourceRefs: [{ sourceId: "source", sourceVersion: 1 }], verification: { kind: "exact", status: "ready", exerciseKeys: ["q"], rubric: null, missingReasons: [] },
  revision: 1, lifecycle: "active", origin: "confirmed", approvedAt: "2026-10-27T00:00:00Z" };
const row = (id: string, overrides: Partial<CourseRouteObservation> = {}): CourseRouteObservation => ({ id, requirementKey: "key", skillLabel: "秩", attemptedAt: "2026-10-27T00:00:00Z", problemId: id,
  usableForCurrentVersion: "yes", verifiedCorrect: "no", independentAttempt: "no", assistance: "hinted", errors: [{ observationId: id, label: "同一步骤", feedback: "核对同一步骤", source: "verified_steps" }],
  courseRequirement: { id: "r", revision: 1, stableSkillId: "s", requirementKey: "key" }, ...overrides });
const scope = { workspaceId: "w", ownerUserId: "u" } as Scope;
// No connection or database package is constructed: mock only scoped I/O;
// the real action entry, requirement qualification, builder and policy run.
const query = vi.fn(async (): Promise<Record<string, unknown>[]> => []);
const sql = Object.assign(query, { begin: async (fn: (tx: unknown) => unknown) => fn(sql) }) as unknown as Sql;
const start = () => createOpeningCourseRouteActions(sql, { compilerEnabled: true }).start(scope, "c", { goalId: "g", expectedGoalRevision: 1, requirementId: "r", expectedRequirementRevision: 1, clientKey: "request", minutes: 20 });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ scopeState: "confirmed", requirements: [{ requirement, status: "needs_correction", observationId: "latest", sourcesAvailable: true, missingReasons: [] }] });
  mocks.goal.mockResolvedValue({ id: "g", revision: 1, courseIds: ["c"] });
  mocks.observations.mockResolvedValue({ projected: [], raw: [] });
  mocks.create.mockImplementation(async (_tx, _scope, input) => ({ id: "activity", learnerFocus: input.goalJson.learnerFocus }));
  mocks.capture.mockResolvedValue({ selectedAction: "full_explain" });
});

describe("course route action canonical teaching decisions", () => {
  it("两次相同受助错误不再混用targeted动作与full原因，回执捕获同一规范输入", async () => {
    mocks.observations.mockResolvedValue({ projected: [row("older", { attemptedAt: "2026-10-26T00:00:00Z" }), row("latest")], raw: [] });
    const result = await start();
    expect(result).toMatchObject({ kind: "ready", action: "full_explain", activity: { learnerFocus: { activityKind: "full_explain", reasonCode: "repeated_assisted_error", focusObservationId: "latest" } } });
    expect(mocks.capture.mock.calls[0]![2]).toMatchObject({ context: { action: "full_explain" }, decisionInput: { status: "needs_check", observations: [{ id: "latest" }, { id: "older" }] } });
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2])("真实复测受助结果覆盖%d次先前独立检查后仍进入减少帮助练习", async priorChecks => {
    const activityId = randomUUID(), observationId = randomUUID(), goalId = randomUUID();
    const currentRequirement = { ...requirement, id: randomUUID(), stableSkillId: randomUUID() };
    const context = { goalId, goalRevision: 1, requirementId: currentRequirement.id, requirementRevision: 1,
      stableSkillId: currentRequirement.stableSkillId, requirementKey: "key", action: "transfer_check", retestId: randomUUID() };
    const binding = { id: currentRequirement.id, revision: 1, stableSkillId: currentRequirement.stableSkillId, requirementKey: "key" };
    const current = row(observationId, { courseRequirement: binding, activityId, verifiedCorrect: "yes", errors: [],
      // The second case has no help on this attempt: the real retest reader
      // reports assistance from delivered interval help on the baseline instead.
      assistance: priorChecks === 1 ? "hinted" : "independent", independentAttempt: priorChecks === 1 ? "no" : "yes" });
    const previous = Array.from({ length: priorChecks }, (_, i) => row(`prior-${i}`, { courseRequirement: binding,
      verifiedCorrect: "yes", assistance: "independent", independentAttempt: "yes", errors: [],
      attemptedAt: `2026-10-${24 + i}T00:00:00Z`, questionIdentity: `question-${i}`, firstQuestionExposure: true }));
    query.mockResolvedValueOnce([{ id: activityId, path_version: 1, goal_json: { courseRoute: context } }]);
    mocks.read.mockResolvedValue({ scopeState: "confirmed", materials: [{ sourceId: "source", sourceVersion: 1, available: true }],
      requirements: [{ requirement: currentRequirement, status: "assisted", observationId, sourcesAvailable: true, missingReasons: [] }] });
    mocks.goal.mockResolvedValue({ id: goalId, revision: 1, courseIds: ["c"] });
    mocks.observations.mockResolvedValue({ projected: [current, ...previous], raw: [{ id: observationId, activityId, submittedAt: current.attemptedAt }] });
    mocks.retestOutcome.mockResolvedValue("assisted");
    const result = await createOpeningCourseRouteActions(sql, { compilerEnabled: true }).next(scope, "c", {
      goalId, expectedGoalRevision: 1, activityId, expectedPathVersion: 1, observationId, clientKey: "next", minutes: 20,
    });
    expect(result).toMatchObject({ kind: "ready", action: "reduced_help_practice", activity: { learnerFocus: {
      activityKind: "reduced_help_practice", reasonCode: "requested_consolidate", recentAssistance: ["hinted", ...previous.map(() => "independent")],
    } } });
    expect(mocks.retestOutcome).toHaveBeenCalledWith(sql, scope, context.retestId, current);
    expect(mocks.capture.mock.calls[0]![2]).toMatchObject({ context: { action: "reduced_help_practice" }, decisionInput: {
      status: "needs_check", learningPhase: "consolidate", phaseSource: "automatic", observations: [{ id: observationId, assistance: "hinted", independentAttempt: "no" }, ...previous.map(previous => ({ id: previous.id })).reverse()],
    } });
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it("旧缺绑定记录不进入决策，即使进度摘要说needs_correction", async () => {
    mocks.observations.mockResolvedValue({ projected: [row("legacy", { courseRequirement: undefined })], raw: [] });
    expect(await start()).toMatchObject({ kind: "ready", action: "diagnose", activity: { learnerFocus: { activityKind: "diagnose", reasonCode: "no_evidence", focusObservationId: null } } });
  });

  it("规范决策改为transfer时仍在创建与预留预算前执行验证材料保护", async () => {
    mocks.read.mockResolvedValue({ scopeState: "confirmed", requirements: [{ requirement: { ...requirement, verification: { ...requirement.verification, status: "missing" } }, status: "assisted", observationId: "current", sourcesAvailable: true, missingReasons: [] }] });
    mocks.observations.mockResolvedValue({ projected: [row("current", { verifiedCorrect: "yes", independentAttempt: "unknown", assistance: "unknown" })], raw: [] });
    expect(await start()).toMatchObject({ kind: "choice", reason: "verification_unavailable" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});
