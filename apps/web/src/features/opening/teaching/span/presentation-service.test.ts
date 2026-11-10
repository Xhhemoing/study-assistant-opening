import { beforeEach, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { getSpanProblem } from "@aistudy/domain";
const mocks = vi.hoisted(() => ({ plan: vi.fn(), session: vi.fn(), create: vi.fn(), generate: vi.fn(), release: vi.fn(), lock: vi.fn() }));
vi.mock("@aistudy/database", () => ({ readOpeningSpanPrerequisiteRepair: mocks.plan,
  createOpeningSpanSessionRepository: () => ({ get: mocks.session }), lockWorkspaceLearningHistory: mocks.lock,
  spanPrerequisiteAttemptKey: (id: string, stage: string) => `span-prerequisite:${id}:v1:${stage}`,
  createOpeningLearningAttemptInTx: mocks.create, generateOpeningStudyExposure: mocks.generate, releaseOpeningStudyExposure: mocks.release }));
import { createSpanPresentationService } from "./presentation-service";
const id = "11111111-1111-4111-8111-111111111111", scope = { workspaceId: id, ownerUserId: id };
const raw = { activityId: id, prerequisiteRepairVersion: 1, stage: "example", clientKey: "example-request" };
const sql = { begin: async (callback: (tx: unknown) => unknown) => callback({}) } as Sql;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.plan.mockResolvedValue({ status: "ready", targetSkill: "equation", teachingExample: { problemId: "span-example-2d", version: "1" } });
  mocks.session.mockResolvedValue({ activityId: id, courseId: id, sessionId: id, sourceIds: [id], status: "active", moveId: "self-example" });
  mocks.create.mockResolvedValue({ id, itemVersionId: id, spanExercise: getSpanProblem("span-example-2d") });
  mocks.generate.mockResolvedValue({ id }); mocks.release.mockResolvedValue({ id, delivered: true });
});
it("uses B semantic identity and releases real example help before responding", async () => {
  const result = await createSpanPresentationService(sql).read(scope, raw);
  expect(mocks.create).toHaveBeenCalledWith(expect.anything(), scope, expect.objectContaining({ clientKey: `span-prerequisite:${id}:v1:example` }));
  expect(mocks.generate.mock.invocationCallOrder[0]).toBeLessThan(mocks.release.mock.invocationCallOrder[0]!);
  expect(result).toMatchObject({ exposureReceipt: { delivered: true }, targetedExplanation: { targetSkill: "equation" } });
  expect(result.targetedExplanation?.stopCondition).toContain("明确返回原要求");
  expect(result).not.toHaveProperty("practiceVariant");
});
it("does not respond with solution content when actual release fails", async () => {
  const error = new Error("release failed"); mocks.release.mockRejectedValueOnce(error);
  await expect(createSpanPresentationService(sql).read(scope, raw)).rejects.toBe(error);
});
it("rejects wrong stage and mixed A/B input before any help generation", async () => {
  await expect(createSpanPresentationService(sql).read(scope, { ...raw, repairVersion: 1 })).rejects.toThrow();
  mocks.session.mockResolvedValueOnce({ status: "active", moveId: "self-faded" });
  await expect(createSpanPresentationService(sql).read(scope, raw)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(mocks.generate).not.toHaveBeenCalled();
});
