import { beforeEach, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
const mocks = vi.hoisted(() => ({ plan: vi.fn(), session: vi.fn(), create: vi.fn(), choice: vi.fn(), binding: vi.fn(), variant: vi.fn() }));
vi.mock("@aistudy/database", () => ({ readOpeningSpanPrerequisiteRepair: mocks.plan,
  createOpeningSpanSessionRepository: () => ({ get: mocks.session }), lockWorkspaceLearningHistory: vi.fn(),
  spanPrerequisiteAttemptKey: (id: string, stage: string) => `span-prerequisite:${id}:v1:${stage}`,
  createOpeningLearningAttemptInTx: mocks.create, readOpeningSpanReservedChoice: mocks.choice,
  readOpeningSpanCourseBinding: mocks.binding, readOpeningSpanRepairVariant: mocks.variant }));
import { createSpanReservedService } from "./reserved-service";
const id = "11111111-1111-4111-8111-111111111111", scope = { workspaceId: id, ownerUserId: id };
const raw = { activityId: id, prerequisiteRepairVersion: 1, expectedRevision: 2, stage: "confirmation", clientKey: "confirmation-request" };
const tx = async () => [];
const sql = { begin: async (callback: (tx: unknown) => unknown) => callback(tx) } as Sql;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.plan.mockResolvedValue({ status: "ready", teachingExample: { problemId: "span-example-2d", version: "1" }, practiceVariant: { problemId: "variant", version: "1" } });
  mocks.session.mockResolvedValue({ activityId: id, courseId: id, sessionId: id, sourceIds: [id], status: "active", moveId: "self_study-reserved", revision: 2 });
  mocks.binding.mockResolvedValue({ allowedExerciseKeys: ["confirmed-validation"] });
  mocks.choice.mockResolvedValue({ kind: "available", problem: { id: "confirmed-validation", version: "1" } });
  mocks.create.mockResolvedValue({ id });
});
it("selects B confirmation only at POST within exact P scope and validation purpose", async () => {
  expect(await createSpanReservedService(sql).issue(scope, raw)).toEqual({ id });
  expect(mocks.choice).toHaveBeenCalledExactlyOnceWith(tx, scope, "self_study", "validation", "span:independent-2d", ["confirmed-validation"]);
  expect(mocks.create).toHaveBeenCalledWith(tx, scope, expect.objectContaining({ clientKey: `span-prerequisite:${id}:v1:confirmation`,
    spanExercise: { sourceId: id, problemId: "confirmed-validation", version: 1 } }), undefined);
});
it("does not choose early or bypass revision", async () => {
  await expect(createSpanReservedService(sql).issue(scope, { ...raw, expectedRevision: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(mocks.choice).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
});
it.each(["unknown_history", "exhausted"])("leaves original state when %s instead of borrowing retest/research", async reason => {
  mocks.choice.mockResolvedValueOnce({ kind: "unavailable", reason });
  await expect(createSpanReservedService(sql).issue(scope, raw)).rejects.toMatchObject({ code: "CONFLICT", reasonCode: reason });
  expect(mocks.create).not.toHaveBeenCalled();
});
