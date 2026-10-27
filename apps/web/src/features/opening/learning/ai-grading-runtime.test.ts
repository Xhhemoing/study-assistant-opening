import { beforeEach, expect, it, vi } from "vitest";
import { getAiGradingService } from "./ai-grading-runtime";
const mocks = vi.hoisted(() => ({ read: vi.fn(), vision: vi.fn(), policy: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@aistudy/database", () => ({ createOpeningAiGradingJobRepository: () => ({ read: mocks.read }),
  readOpeningObservationGradingUsesVision: mocks.vision }));
vi.mock("./auto-grade-policy", () => ({ resolveAutoGradePolicy: mocks.policy }));
const scope = { workspaceId: "w", ownerUserId: "u" }, sql = {} as never;
beforeEach(() => { vi.clearAllMocks(); mocks.policy.mockResolvedValue({ enabled: true }); });
it("uses server visual references to explain a saved text answer's non-admission", async () => {
  mocks.read.mockResolvedValueOnce({ jobId: null, retryable: true, headObservationId: "saved-head", workSource: null }).mockResolvedValueOnce({ autoGradeSkipped: "budget_unavailable" });
  mocks.vision.mockResolvedValue(true);
  await expect(getAiGradingService(sql).read(scope, { observationId: "original" })).resolves.toEqual({ autoGradeSkipped: "budget_unavailable" });
  expect(mocks.vision).toHaveBeenCalledWith(sql, scope, "saved-head");
  expect(mocks.policy).toHaveBeenCalledWith(sql, scope, true);
});
it.each([{ jobId: "existing", retryable: true }, { jobId: null, retryable: false }])("keeps historical or queued reads free of new visual validation: %j", async status => {
  mocks.read.mockResolvedValue(status);
  expect(await getAiGradingService(sql).read(scope, {})).toBe(status);
  expect(mocks.vision).not.toHaveBeenCalled(); expect(mocks.policy).not.toHaveBeenCalled();
});
it("reports unavailable references without interpreting them as an ordinary text task", async () => {
  mocks.read.mockResolvedValueOnce({ jobId: null, retryable: true, headObservationId: "h", workSource: null }).mockResolvedValueOnce({ autoGradeSkipped: "no_model" });
  mocks.vision.mockResolvedValue(null); mocks.policy.mockResolvedValue({ enabled: true, modelAvailable: true });
  await getAiGradingService(sql).read(scope, {});
  expect(mocks.read.mock.calls[1]![2]).toMatchObject({ modelAvailable: false, modelUnavailableReason: "no_model", primaryModel: null, fallbackModel: null });
});
