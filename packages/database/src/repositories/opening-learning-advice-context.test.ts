import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { SPAN_SKILL_LABEL } from "@aistudy/domain";
import { createOpeningLearningAdviceContextRepository } from "./opening-learning-advice-context";

const dependencies = vi.hoisted(() => ({ binding: vi.fn(), attempt: vi.fn(), authorization: vi.fn(), intent: vi.fn(), due: vi.fn(), facts: vi.fn() }));
vi.mock("./opening-span-course-binding", () => ({ readOpeningSpanCourseBinding: dependencies.binding, readOpeningSpanCourseAttempt: dependencies.attempt }));
vi.mock("./opening-span-tutor-grant", () => ({ readSpanTutorAuthorization: dependencies.authorization }));
vi.mock("./opening-study-intent-events", () => ({ readOpeningStudyIntentInTx: dependencies.intent }));
vi.mock("./opening-retest-activities", () => ({ createOpeningRetestActivityRepository: () => ({ listDue: dependencies.due }) }));
vi.mock("./opening-span-tutor-context", () => ({ readOpeningSpanAdviceDecisionInTx: dependencies.facts }));
const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
const anchor = { activityId: randomUUID(), attemptId: randomUUID(), expectedRevision: 2 };
const courseId = randomUUID(), sessionId = randomUUID(), sourceId = randomUUID();
const intent = { purpose: "self_study", timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" };
function activity() {
  return { id: anchor.activityId, course_id: courseId, session_id: sessionId, status: "active", path_version: 2,
    source_ids: [sourceId], session_source_ids: [sourceId], session_skill_label: SPAN_SKILL_LABEL,
    create_intent: { protocol: "span-lesson-v1", kind: "course_route" }, goal_json: { spanCourseBinding: {}, sessionIntent: intent },
    checkpoint_json: { spanLesson: { sessionId, intent, moveId: "self_study-reserved", retestId: null } },
    created_at: new Date(), updated_at: new Date() };
}
function harness(row: unknown = activity(), attemptRows: unknown[] = [{ id: anchor.attemptId }], help: unknown[] = []) {
  const tx = vi.fn().mockResolvedValueOnce(row ? [row] : []).mockResolvedValueOnce(attemptRows).mockResolvedValueOnce(help);
  const begin = vi.fn(async (_options, callback) => callback(tx));
  return { tx, begin, repo: createOpeningLearningAdviceContextRepository({ begin } as unknown as Sql) };
}
beforeEach(() => {
  vi.resetAllMocks();
  dependencies.binding.mockResolvedValue({ binding: { courseId }, sessionId, requirement: { sourceRefs: [{ sourceId, sourceVersion: 1 }] } });
  dependencies.attempt.mockResolvedValue({}); dependencies.authorization.mockResolvedValue({ authorized: true });
  dependencies.intent.mockResolvedValue(null); dependencies.due.mockResolvedValue([]);
  dependencies.facts.mockResolvedValue({ decision: { activityKind: "diagnose", reasonCode: "no_evidence", focusObservationId: null }, sourceRefs: ["private"] });
});
describe("read-only advice context orchestration (not auth/SQL execution proof)", () => {
  it("uses the original facts and current binding in the same rule-only tx", async () => {
    const h = harness();
    expect(await h.repo.read(scope, anchor)).toEqual({ ruleDecision: { activityKind: "diagnose", reasonCode: "no_evidence" } });
    expect(h.begin).toHaveBeenCalledWith("isolation level repeatable read read only", expect.any(Function));
    expect(dependencies.binding).toHaveBeenCalledWith(h.tx, scope, anchor.activityId);
    expect(dependencies.attempt).toHaveBeenCalledWith(h.tx, scope, { id: anchor.attemptId }, await dependencies.binding.mock.results[0]!.value);
    expect(dependencies.facts).toHaveBeenCalledWith(h.tx, scope, { courseId }, [sourceId], { [sourceId]: 1 }, intent, null);
  });
  it("does not use latest revision, search for another attempt or mask a dependency failure", async () => {
    const stale = harness({ ...activity(), path_version: 3 });
    await expect(stale.repo.read(scope, anchor)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(stale.tx).toHaveBeenCalledTimes(1);
    await expect(harness(null).repo.read(scope, anchor)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(harness(activity(), []).repo.read(scope, anchor)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const error = new Error("connection failed"); dependencies.binding.mockRejectedValue(error);
    await expect(harness().repo.read(scope, anchor)).rejects.toBe(error);
  });
  it.each(["paused", "completed"])("refuses %s without computing facts", async status => {
    expect(await harness({ ...activity(), status }).repo.read(scope, anchor)).toBeNull();
    expect(dependencies.facts).not.toHaveBeenCalled();
  });
  it.each(["spanRepair", "spanPrerequisiteRepair", "tutorNextAction", "reservedStart"])("refuses unsupported %s", async key => {
    const row = activity(); row.goal_json = { ...row.goal_json, [key]: {} };
    expect(await harness(row).repo.read(scope, anchor)).toBeNull();
    expect(dependencies.facts).not.toHaveBeenCalled();
  });
  it("does not default missing persisted retest/intent/priority facts", async () => {
    const row = activity(); delete (row.checkpoint_json.spanLesson as Record<string, unknown>).retestId;
    expect(await harness(row).repo.read(scope, anchor)).toBeNull();
    const mismatch = activity(); mismatch.goal_json.sessionIntent = { ...intent, timeBudgetMinutes: 30 };
    expect(await harness(mismatch).repo.read(scope, anchor)).toBeNull();
    dependencies.intent.mockResolvedValue({ id: randomUUID(), activityId: anchor.activityId, action: "clarify_intent", intent });
    expect(await harness().repo.read(scope, anchor)).toBeNull();
    expect(dependencies.facts).not.toHaveBeenCalled();
  });
  it("does not turn missing authorization, due retest or delivered course help into false", async () => {
    dependencies.authorization.mockResolvedValue({ authorized: false });
    expect(await harness().repo.read(scope, anchor)).toBeNull();
    dependencies.authorization.mockResolvedValue({ authorized: true });
    dependencies.due.mockResolvedValue([{ requirementKey: "span:linear-combination:v1", skillLabel: SPAN_SKILL_LABEL }]);
    expect(await harness().repo.read(scope, anchor)).toBeNull();
    dependencies.due.mockResolvedValue([]);
    expect(await harness(activity(), [{ id: anchor.attemptId }], [{ id: randomUUID() }]).repo.read(scope, anchor)).toBeNull();
    expect(dependencies.facts).not.toHaveBeenCalled();
  });
  it("propagates current membership/version/binding rejection without using old rule", async () => {
    dependencies.binding.mockRejectedValue(Object.assign(new Error("binding changed"), { code: "CONFLICT" }));
    await expect(harness().repo.read(scope, anchor)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dependencies.facts).not.toHaveBeenCalled();
  });
});
