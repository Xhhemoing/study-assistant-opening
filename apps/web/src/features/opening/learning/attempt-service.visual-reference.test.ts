import { beforeEach, expect, it, vi } from "vitest";
import { createOpeningAttemptService } from "./attempt-service";
const mocks = vi.hoisted(() => ({ access: vi.fn(), vision: vi.fn(), policy: vi.fn(), insert: vi.fn() }));
vi.mock("@aistudy/database", () => ({
  createOpeningLearningAttemptRepository: () => ({ assertAccess: mocks.access }),
  createOpeningLearningRepository: () => ({ listDeliveredExposures: async () => [], insertObservation: mocks.insert }),
  createOpeningKnowledgeRepository: () => ({}), readOpeningAttemptGradingUsesVision: mocks.vision,
}));
vi.mock("./auto-grade-policy", () => ({ resolveAutoGradePolicy: mocks.policy }));
const id = "11111111-1111-4111-8111-111111111111";
const scope = { workspaceId: id, ownerUserId: id };
beforeEach(() => {
  vi.clearAllMocks(); mocks.access.mockResolvedValue({ id, sessionId: id, courseId: id, sourceIds: [id], skillLabel: "calculus", problemId: id, itemVersionId: id });
  mocks.policy.mockResolvedValue({}); mocks.insert.mockResolvedValue({ id });
});
it("chooses vision for a typed answer when the sealed server question has visual references", async () => {
  mocks.vision.mockResolvedValue(true);
  await createOpeningAttemptService({} as never).submit(scope, id, { clientKey: "typed-visual-question", answer: "1", outcome: "unverified", assistance: "independent" });
  expect(mocks.vision).toHaveBeenCalledWith(expect.anything(), scope, id);
  expect(mocks.policy).toHaveBeenCalledWith(expect.anything(), scope, true);
});
it("keeps text routing when only unrelated material is visual", async () => {
  mocks.vision.mockResolvedValue(false);
  await createOpeningAttemptService({} as never).submit(scope, id, { clientKey: "text-question", answer: "1", outcome: "unverified", assistance: "independent" });
  expect(mocks.policy).toHaveBeenCalledWith(expect.anything(), scope, false);
});
it("does not put a new source validation in front of a submitted answer receipt", async () => {
  mocks.access.mockResolvedValue({ id, sessionId: id, courseId: id, sourceIds: [id], skillLabel: "calculus", problemId: id, itemVersionId: id, submittedAt: "2026-10-27T00:00:00Z" });
  mocks.vision.mockRejectedValue(new Error("source since changed"));
  await expect(createOpeningAttemptService({} as never).submit(scope, id, { clientKey: "original-answer", answer: "1", outcome: "unverified", assistance: "independent" })).resolves.toEqual({ id });
  expect(mocks.vision).not.toHaveBeenCalled();
});
it.each([false, true])("preserves the old answer when its exact reference is unavailable with automatic grading %s", async enabled => {
  mocks.vision.mockResolvedValue(null); mocks.policy.mockResolvedValue({ enabled, modelAvailable: true, primaryModel: { id: "text" }, fallbackModel: { id: "fallback" } });
  await expect(createOpeningAttemptService({} as never).submit(scope, id, { clientKey: "missing-old-ref", answer: "original work", outcome: "unverified", assistance: "independent" })).resolves.toEqual({ id });
  expect(mocks.insert.mock.calls[0]![2].autoGrade).toMatchObject({ enabled, modelAvailable: false, modelUnavailableReason: "no_model", primaryModel: null, fallbackModel: null });
});
