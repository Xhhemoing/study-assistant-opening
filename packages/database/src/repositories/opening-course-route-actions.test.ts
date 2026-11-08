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

  it.each([0, 1, 2])("真实复测受助结果在%d次先前独立检查后保持v2路线减少帮助练习", async priorChecks => {
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
      activityKind: "reduced_help_practice", reasonCode: priorChecks === 0 ? "assistance_dependent" : "route_assisted_correction", recentAssistance: ["hinted", ...previous.map(() => "independent")],
    } } });
    expect(mocks.retestOutcome).toHaveBeenCalledWith(sql, scope, context.retestId, current);
    expect(mocks.capture.mock.calls[0]![2]).toMatchObject({ context: { action: "reduced_help_practice" }, decisionInput: {
      status: "needs_check", observations: [{ id: observationId, assistance: "hinted", independentAttempt: "no" }, ...previous.map(previous => ({ id: previous.id })).reverse()],
    } });
    // The canonical v2 input carries no phase control; the route override stays local.
    expect(mocks.capture.mock.calls[0]![2].decisionInput).not.toHaveProperty("learningPhase");
    expect(mocks.capture.mock.calls[0]![2].decisionInput).not.toHaveProperty("phaseSource");
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it("读取路线时透传仓库的确定性判定开关", async () => {
    await createOpeningCourseRouteActions(sql, { compilerEnabled: true, exactVerificationEnabled: true }).start(scope, "c", { goalId: "g", expectedGoalRevision: 1, requirementId: "r", expectedRequirementRevision: 1, clientKey: "request", minutes: 20 });
    expect(mocks.read).toHaveBeenCalledWith(sql, scope, "c", undefined, true);
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

  it("前置绕行保留prerequisite路线动作且不经验证材料保护，learnerFocus取前置要求的规范决策", async () => {
    // The prerequisite has no ready verification: only transfer_check/comprehensive are guarded.
    const prerequisite: CourseRequirement = { ...requirement, id: "p", stableSkillId: "ps", requirementKey: "pkey", title: "前置", position: 0,
      verification: { ...requirement.verification, status: "missing" } };
    const target: CourseRequirement = { ...requirement, position: 1, prerequisiteIds: ["p"] };
    const binding = { id: "p", revision: 1, stableSkillId: "ps", requirementKey: "pkey" };
    mocks.read.mockResolvedValue({ scopeState: "confirmed", requirements: [
      { requirement: prerequisite, status: "needs_correction", observationId: "progress-head", sourcesAvailable: true, missingReasons: [] },
      { requirement: target, status: "unobserved", observationId: null, sourcesAvailable: true, missingReasons: [] }] });
    mocks.observations.mockResolvedValue({ projected: [
      row("p-old", { requirementKey: "pkey", courseRequirement: binding, attemptedAt: "2026-10-26T00:00:00Z" }),
      row("p-new", { requirementKey: "pkey", courseRequirement: binding })], raw: [] });
    const result = await start();
    expect(result).toMatchObject({ kind: "ready", action: "prerequisite", requirementId: "p", activity: { learnerFocus: {
      requirementKey: "pkey", activityKind: "full_explain", reasonCode: "repeated_assisted_error", focusObservationId: "p-new" } } });
    // The route-level focus is the progress head; the teaching focus is the decision's own.
    expect(mocks.capture.mock.calls[0]![2]).toMatchObject({ initialStep: { action: "prerequisite", requirementId: "p", returnTo: "r", focusObservationId: "progress-head" },
      context: { action: "prerequisite", requirementId: "p", returnTo: "r" } });
    expect(mocks.create.mock.calls[0]![2].intentSummary).toMatch(/^先补前置要求/);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
  });
});

describe("course route next: return and comprehensive paths", () => {
  type Fixture = { goalId: string; activityId: string; observationId: string };
  const next = (f: Fixture) => createOpeningCourseRouteActions(sql, { compilerEnabled: true }).next(scope, "c", {
    goalId: f.goalId, expectedGoalRevision: 1, activityId: f.activityId, expectedPathVersion: 1, observationId: f.observationId, clientKey: "next", minutes: 20 });
  const bound = (r: CourseRequirement) => ({ id: r.id, revision: r.revision, stableSkillId: r.stableSkillId, requirementKey: r.requirementKey });
  const correct = { verifiedCorrect: "yes", independentAttempt: "yes", assistance: "independent", errors: [] } satisfies Partial<CourseRouteObservation>;
  const materials = [{ sourceId: "source", sourceVersion: 1, available: true }];
  const progressRow = (r: CourseRequirement, status: string, observationId: string | null) => ({ requirement: r, status, observationId, sourcesAvailable: true, missingReasons: [] });

  it("从已通过的前置要求返回原要求时动作为return，learnerFocus仍取原要求的规范决策", async () => {
    const f = { goalId: randomUUID(), activityId: randomUUID(), observationId: randomUUID() };
    const p: CourseRequirement = { ...requirement, id: randomUUID(), stableSkillId: randomUUID(), requirementKey: "pkey", title: "前置", position: 0 };
    const r: CourseRequirement = { ...requirement, id: randomUUID(), stableSkillId: randomUUID(), position: 1, prerequisiteIds: [p.id] };
    const context = { goalId: f.goalId, goalRevision: 1, requirementId: p.id, requirementRevision: 1, stableSkillId: p.stableSkillId,
      requirementKey: "pkey", action: "prerequisite", returnTo: r.id };
    const current = row(f.observationId, { ...correct, requirementKey: "pkey", courseRequirement: bound(p), activityId: f.activityId,
      questionIdentity: "pq-2", firstQuestionExposure: true });
    const earlier = row("p-earlier", { ...correct, requirementKey: "pkey", courseRequirement: bound(p), attemptedAt: "2026-10-26T00:00:00Z",
      questionIdentity: "pq-1", firstQuestionExposure: true });
    // The detour really happened: p was judged wrong before its two independent successes.
    const wrong = row("p-wrong", { requirementKey: "pkey", courseRequirement: bound(p), attemptedAt: "2026-10-25T06:00:00Z" });
    query.mockResolvedValueOnce([{ id: f.activityId, path_version: 1, goal_json: { courseRoute: context } }]);
    mocks.goal.mockResolvedValue({ id: f.goalId, revision: 1, courseIds: ["c"] });
    mocks.read.mockResolvedValue({ scopeState: "confirmed", materials, requirements: [progressRow(p, "needs_verification", f.observationId), progressRow(r, "needs_correction", "r-new")] });
    mocks.observations.mockResolvedValue({ projected: [current, earlier, wrong, row("r-old", { courseRequirement: bound(r), attemptedAt: "2026-10-25T00:00:00Z" }),
      row("r-new", { courseRequirement: bound(r), attemptedAt: "2026-10-26T12:00:00Z" })], raw: [{ id: f.observationId, activityId: f.activityId, submittedAt: current.attemptedAt }] });
    const result = await next(f);
    // Route navigation says "return"; selectCourseRouteStep alone would say targeted_explain.
    expect(result).toMatchObject({ kind: "ready", action: "return", requirementId: r.id, activity: { learnerFocus: {
      requirementKey: "key", activityKind: "full_explain", reasonCode: "repeated_assisted_error", focusObservationId: "r-new" } } });
    expect(mocks.capture.mock.calls[0]![2]).toMatchObject({ initialStep: { requirementId: r.id, action: "targeted_explain" }, context: { action: "return", requirementId: r.id } });
    expect(mocks.capture.mock.calls[0]![2].context).not.toHaveProperty("returnTo");
    expect(mocks.create.mock.calls[0]![2].intentSummary).toMatch(/^返回原要求/);
  });

  type ComprehensiveOptions = { b?: Partial<CourseRequirement>; bProgress?: [string, string | null]; extra?: (reqB: CourseRequirement) => CourseRouteObservation[] };
  /** Production enters a comprehensive run only after every requirement is verified
   * (opening-course-route-actions.ts, no remaining step), and verified needs two
   * independent first-exposure successes on different questions. So each requirement
   * carries that history, earlier than the run and outside its run key. */
  const comprehensive = (current: Partial<CourseRouteObservation>, options: ComprehensiveOptions = {}) => {
    const f = { goalId: randomUUID(), activityId: randomUUID(), observationId: randomUUID() };
    const reqA: CourseRequirement = { ...requirement, id: randomUUID(), stableSkillId: randomUUID(), requirementKey: "akey", title: "甲", position: 0 };
    const verifiedB: CourseRequirement = { ...requirement, id: randomUUID(), stableSkillId: randomUUID(), requirementKey: "bkey", title: "乙", position: 1 };
    const reqB: CourseRequirement = { ...verifiedB, ...options.b };
    const history = (r: CourseRequirement, prefix: string) => [1, 2].map(i => row(`${prefix}-verified-${i}`, { ...correct, requirementKey: r.requirementKey,
      courseRequirement: bound(r), attemptedAt: `2026-10-2${i}T00:00:00Z`, questionIdentity: `${prefix}-question-${i}`, firstQuestionExposure: true }));
    const runKey = "course-route-start:c:comprehensive-run";
    const context = { goalId: f.goalId, goalRevision: 1, requirementId: reqA.id, requirementRevision: 1, stableSkillId: reqA.stableSkillId,
      requirementKey: "akey", action: "comprehensive", coveredRequirementIds: [reqA.id, reqB.id], comprehensiveRunKey: runKey };
    const head = row(f.observationId, { requirementKey: "akey", courseRequirement: bound(reqA), activityId: f.activityId, routeAction: "comprehensive",
      comprehensiveRunKey: runKey, questionIdentity: "a-question-run", errors: [], ...current });
    query.mockResolvedValueOnce([{ id: f.activityId, path_version: 1, goal_json: { courseRoute: context } }]);
    mocks.goal.mockResolvedValue({ id: f.goalId, revision: 1, courseIds: ["c"] });
    const [bStatus, bObservation] = options.bProgress ?? ["verified", "b-verified-2"];
    mocks.read.mockResolvedValue({ scopeState: "confirmed", materials, requirements: [progressRow(reqA, "verified", "a-verified-2"), progressRow(reqB, bStatus, bObservation)] });
    // B's history stays bound to the revision it was recorded under.
    mocks.observations.mockResolvedValue({ projected: [head, ...history(reqA, "a"), ...history(verifiedB, "b"), ...(options.extra?.(reqB) ?? [])],
      raw: [{ id: f.observationId, activityId: f.activityId, submittedAt: head.attemptedAt }] });
    return { f, reqA, reqB };
  };

  it("综合检查当前观察判错时，焦点是该观察id，路线动作保持comprehensive", async () => {
    const { f, reqA, reqB } = comprehensive({ verifiedCorrect: "no", independentAttempt: "yes", assistance: "independent" });
    expect(await next(f)).toMatchObject({ kind: "ready", action: "comprehensive", requirementId: reqA.id, activity: { learnerFocus: {
      activityKind: "targeted_explain", reasonCode: "verified_incorrect", focusObservationId: f.observationId } } });
    expect(mocks.capture.mock.calls[0]![2].context).toMatchObject({ action: "comprehensive", coveredRequirementIds: [reqA.id, reqB.id] });
  });

  it("综合检查当前观察判对（受助，仍需本项检查）时，保持路线覆盖减少帮助练习，焦点为null", async () => {
    const { f, reqA } = comprehensive({ verifiedCorrect: "yes", independentAttempt: "no", assistance: "hinted" });
    // A's two earlier independent checks do not cancel the latest assisted success.
    expect(await next(f)).toMatchObject({ kind: "ready", action: "comprehensive", requirementId: reqA.id, activity: { learnerFocus: {
      activityKind: "reduced_help_practice", reasonCode: "route_assisted_correction", focusObservationId: null,
      recentAssistance: ["hinted", "independent", "independent"] } } });
    expect(mocks.capture.mock.calls[0]![2]).toMatchObject({ requestedId: reqA.id, context: { action: "comprehensive" }, decisionInput: {
      status: "needs_check", observations: [{ id: f.observationId }, { id: "a-verified-2" }, { id: "a-verified-1" }] } });
  });

  it("综合检查转到其他要求时，不把原要求当前观察的id当作焦点，决策只用该要求自己的历史", async () => {
    const { f, reqB } = comprehensive({ ...correct, firstQuestionExposure: true });
    expect(await next(f)).toMatchObject({ kind: "ready", action: "comprehensive", requirementId: reqB.id, activity: { learnerFocus: {
      requirementKey: "bkey", activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null,
      recentAssistance: ["independent", "independent"] } } });
    const binding = { courseRequirement: { id: reqB.id } };
    expect(mocks.capture.mock.calls[0]![2]).toMatchObject({ requestedId: reqB.id, decisionInput: { status: "observed_independent",
      observations: [{ id: "b-verified-2", ...binding }, { id: "b-verified-1", ...binding }] } });
  });

  it("综合检查转到的要求自己有更早的判错观察时，焦点是那条观察的id", async () => {
    // b-wrong is newer than B's verified history but outside the run key: B still needs this run's check.
    const { f, reqB } = comprehensive({ ...correct, firstQuestionExposure: true }, { bProgress: ["needs_correction", "b-wrong"],
      extra: target => [row("b-wrong", { requirementKey: "bkey", courseRequirement: bound(target), attemptedAt: "2026-10-25T00:00:00Z" })] });
    expect(await next(f)).toMatchObject({ kind: "ready", action: "comprehensive", requirementId: reqB.id, activity: { learnerFocus: {
      requirementKey: "bkey", activityKind: "targeted_explain", reasonCode: "verified_incorrect", focusObservationId: "b-wrong" } } });
    expect(mocks.capture.mock.calls[0]![2]).toMatchObject({ requestedId: reqB.id, context: { action: "comprehensive", requirementId: reqB.id },
      decisionInput: { observations: [{ id: "b-wrong" }, { id: "b-verified-2" }, { id: "b-verified-1" }] } });
  });

  it("综合检查转到的要求验证材料未就绪时返回verification_unavailable，不创建活动或预留预算", async () => {
    // Writing verification bumps the revision, so B's verified history (revision 1) no longer qualifies.
    const { f, reqB } = comprehensive({ ...correct, firstQuestionExposure: true }, { bProgress: ["unobserved", null],
      b: { revision: 2, verification: { ...requirement.verification, status: "missing" } } });
    expect(await next(f)).toMatchObject({ kind: "choice", reason: "verification_unavailable", requirementIds: [reqB.id] });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});
