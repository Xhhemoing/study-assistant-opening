import { beforeEach, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { DEFAULT_STUDY_SESSION_INTENT } from "@aistudy/domain";
import { createSpanTutorNextAction } from "./span-tutor-next-action";
import { prepareTutorNextAction } from "../jobs/tutor-next-action";

const repository = vi.hoisted(() => ({ read: vi.fn(), execute: vi.fn(), assertCurrent: vi.fn() }));
vi.mock("@aistudy/database", async importOriginal => ({ ...await importOriginal<object>(), createOpeningSpanTutorContextRepository: () => repository,
  createOpeningLearningAgendaRepository: () => ({ get: async () => null }) }));
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const request = { courseId: "course", sourceIds: ["source"], sourceVersions: { source: 1 }, question: "继续", userTurnId: "turn", operationId: "tutor-next:turn" };
const session = { activityId: "activity", sessionId: "session", courseId: "course", sourceIds: ["source"], intent: DEFAULT_STUDY_SESSION_INTENT,
  moveId: "self-faded", status: "active", revision: 2, retestId: null, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z" };
const context = () => ({ courseId: "course", grantRevision: 1, privacyEpoch: 0, sourceRefs: [{ sourceId: "source", sourceVersion: 1 }],
  sourceIds: ["source"], sourceVersions: { source: 1 }, decisionInput: { status: "unobserved", observations: [], wantsFullExplanation: false },
  intent: DEFAULT_STUDY_SESSION_INTENT, resumeSession: null, dueRetestId: null });
beforeEach(() => { vi.resetAllMocks(); });

it("uses the persisted activity as the session query parameter for resuming a span lesson", async () => {
  repository.read.mockResolvedValue({ ...context(), resumeSession: session });
  const prepared = await createSpanTutorNextAction({} as Sql).read(scope, request);
  expect(prepared).toMatchObject({ resume: { activityId: "activity", sessionId: "session", href: "/opening/courses/course/study/span?lesson=activity" } });
});
it("carries the actual created session into the second permission/version check", async () => {
  const stored = context();
  repository.read.mockResolvedValue(stored);
  repository.execute.mockImplementation(async () => { Object.assign(stored, { resumeSession: session }); return session; });
  const adapter = createSpanTutorNextAction({} as Sql), prepared = (await adapter.read(scope, request))!;
  const action = await adapter.execute(scope, { ...request, context: prepared, decision: { activityKind: "diagnose", focusObservationId: null, reasonCode: "no_evidence" } });
  await adapter.assertCurrent(scope, prepared);
  expect(action).toEqual({ activityId: "activity", sessionId: "session", href: "/opening/courses/course/study/span?lesson=activity" });
  expect(repository.assertCurrent.mock.calls[0]?.[1]).toMatchObject({ resumeSession: { activityId: "activity", revision: 2 } });
});
it("retains the retest identity when resuming an existing delayed session", async () => {
  repository.read.mockResolvedValue({ ...context(), resumeSession: { ...session, retestId: "retest" } });
  expect(await createSpanTutorNextAction({} as Sql).read(scope, request)).toMatchObject({
    resume: { href: "/opening/courses/course/study/span?lesson=activity&retest=retest" },
  });
});
it("leaves unauthorized courses on their existing proposal path", async () => {
  repository.read.mockResolvedValue(null);
  expect(await createSpanTutorNextAction({} as Sql).read(scope, request)).toBeNull();
});
const limitedInput = () => ({ ...context().decisionInput, remediationCycles: { completedCycles: ["failure-one", "failure-two"].map(failureRootId => ({
  failureRootId, repeatedVerifiedError: false, persistentDeliveredAssistance: true,
  evidenceRefs: [`observation:${failureRootId}`, `help_exposure:${failureRootId}`, `observation:followup-${failureRootId}`],
})) } });
it.each(["new_activity", "early_resume", "reserved_resume"] as const)("returns a safe remediation choice before %s without execute", async branch => {
  const stored = { ...context(), decisionInput: limitedInput(),
    ...(branch === "new_activity" ? {} : { resumeSession: session }),
    ...(branch === "reserved_resume" ? { needsReservedIssue: true } : {}) };
  repository.read.mockResolvedValue(stored);
  const before = structuredClone(stored), adapter = createSpanTutorNextAction({} as Sql);
  const result = await prepareTutorNextAction(adapter, scope, request);
  expect(result).toMatchObject({ action: null, resumed: false, decision: { reasonCode: "remediation_limit" },
    choice: { href: branch === "new_activity" ? "/opening/courses/course/study" : "/opening/courses/course/study/span?lesson=activity" } });
  expect(result?.choice?.message).toContain("没有新增题目、活动或预算");
  expect(repository.execute).not.toHaveBeenCalled();
  expect(repository.assertCurrent).toHaveBeenCalledWith(scope, stored);
  expect(stored).toEqual(before);
});
it("keeps an exact historical operation ahead of today's remediation suggestion", async () => {
  const historicalDecision = { activityKind: "diagnose", focusObservationId: null, reasonCode: "no_evidence" };
  repository.read.mockResolvedValue({ ...context(), decisionInput: limitedInput(), resumeSession: session,
    historicalOperationId: request.operationId, historicalDecision });
  const result = await prepareTutorNextAction(createSpanTutorNextAction({} as Sql), scope, request);
  expect(result).toMatchObject({ resumed: true, action: { activityId: session.activityId }, decision: historicalDecision });
  expect(result?.choice).toBeUndefined();
  expect(repository.execute).not.toHaveBeenCalled();
});
it("passes explicit overview-only updates to the repository for authoritative revalidation", async () => {
  const stored = { ...context(), decisionInput: limitedInput(), resumeSession: session,
    intent: { ...DEFAULT_STUDY_SESSION_INTENT, purpose: "overview" }, needsIntentUpdate: true };
  repository.read.mockResolvedValue(stored);
  repository.execute.mockResolvedValue({ ...session, intent: stored.intent });
  const result = await prepareTutorNextAction(createSpanTutorNextAction({} as Sql), scope, { ...request, question: "串讲" });
  expect(result).toMatchObject({ action: { activityId: session.activityId } });
  expect(repository.execute).toHaveBeenCalledWith(scope, expect.objectContaining({ context: stored }));
  expect(repository.assertCurrent).toHaveBeenCalledWith(scope, stored);
});
it("propagates repository admission failures for an explicit intent-only update instead of hiding a conflict", async () => {
  repository.read.mockResolvedValue({ ...context(), decisionInput: limitedInput(), resumeSession: session,
    intent: { ...DEFAULT_STUDY_SESSION_INTENT, purpose: "overview" }, needsIntentUpdate: true });
  repository.execute.mockRejectedValueOnce(Object.assign(new Error("job cancelled"), { code: "CONFLICT" }));
  await expect(prepareTutorNextAction(createSpanTutorNextAction({} as Sql), scope, { ...request, question: "串讲" })).rejects.toThrow("job cancelled");
});
it.each(["reserved", "due_retest"])("does not exempt an overview change needing %s work", async branch => {
  repository.read.mockResolvedValue({ ...context(), decisionInput: limitedInput(), needsIntentUpdate: true,
    intent: { ...DEFAULT_STUDY_SESSION_INTENT, purpose: "overview" },
    resumeSession: { ...session, moveId: branch === "reserved" ? "self_study-reserved" : session.moveId,
      retestId: branch === "due_retest" ? "retest" : null } });
  expect(await prepareTutorNextAction(createSpanTutorNextAction({} as Sql), scope, request)).toMatchObject({ action: null,
    choice: { href: expect.stringContaining("/opening/courses/course/study/span?") } });
  expect(repository.execute).not.toHaveBeenCalled();
});
it.each(["authorization revoked", "cross-scope denied", "origin changed"])("does not swallow %s as a remediation choice", async message => {
  repository.read.mockResolvedValue({ ...context(), decisionInput: limitedInput() });
  repository.assertCurrent.mockRejectedValueOnce(Object.assign(new Error(message), { code: "CONFLICT" }));
  await expect(prepareTutorNextAction(createSpanTutorNextAction({} as Sql), scope, request)).rejects.toThrow(message);
  expect(repository.execute).not.toHaveBeenCalled();
});
it("offers the actual current origin when the stored derived recommendation became stale", async () => {
  repository.read.mockResolvedValue({ ...context(), resumeSession: session,
    originChange: { reason: "evidence_changed", originSession: { ...session, activityId: "origin", revision: 7 }, observationId: "current-head" } });
  expect(await createSpanTutorNextAction({} as Sql).read(scope, request)).toMatchObject({ unavailableAction: {
    href: "/opening/courses/course/study/span?lesson=origin",
  } });
});
