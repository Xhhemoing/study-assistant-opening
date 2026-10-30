import { beforeEach, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { DEFAULT_STUDY_SESSION_INTENT } from "@aistudy/domain";
import { createSpanTutorNextAction } from "./span-tutor-next-action";

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
it("offers the actual current origin when the stored derived recommendation became stale", async () => {
  repository.read.mockResolvedValue({ ...context(), resumeSession: session,
    originChange: { reason: "evidence_changed", originSession: { ...session, activityId: "origin", revision: 7 }, observationId: "current-head" } });
  expect(await createSpanTutorNextAction({} as Sql).read(scope, request)).toMatchObject({ unavailableAction: {
    href: "/opening/courses/course/study/span?lesson=origin",
  } });
});
