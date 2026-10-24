import { beforeEach, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
const mocks = vi.hoisted(() => ({ access: vi.fn(), exposures: vi.fn(), insert: vi.fn(), spanLesson: vi.fn(), sql: vi.fn(), knowledge: vi.fn() }));
vi.mock("@aistudy/database", () => ({
  createOpeningLearningAttemptRepository: () => ({ assertAccess: mocks.access }),
  createOpeningLearningRepository: () => ({ listDeliveredExposures: mocks.exposures, insertObservation: mocks.insert }),
  createOpeningKnowledgeRepository: () => ({ get: mocks.knowledge }),
  createOpeningSpanSessionRepository: () => ({ get: mocks.spanLesson }),
}));
import { createOpeningAttemptService } from "./attempt-service";
const id = "11111111-1111-4111-8111-111111111111";
const scope = { workspaceId: id, ownerUserId: id };
const body = { clientKey: "span-original-answer", answer: "original", outcome: "unverified", assistance: "independent" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ id, sessionId: id, courseId: id, sourceIds: [id], skillLabel: "span", problemId: id, contextAnchor: { activityId: id }, spanExercise: {} });
  mocks.exposures.mockResolvedValue(["hinted"]); mocks.sql.mockResolvedValue([]); mocks.spanLesson.mockResolvedValue({ sessionId: id }); mocks.insert.mockResolvedValue({ id, answer: "original", assistance: "hinted" });
});
it("keeps a dedicated span lesson's submitted assistance stable as later help increases", async () => {
  const service = createOpeningAttemptService(mocks.sql as unknown as Sql);
  await service.submit(scope, id, body);
  expect(mocks.insert).toHaveBeenLastCalledWith(scope, expect.objectContaining({ assistance: "hinted", answer: "original" }), { submittedAssistance: "independent" });
  mocks.exposures.mockResolvedValue(["hinted", "revealed"]);
  expect(await service.submit(scope, id, body)).toMatchObject({ id, assistance: "hinted" });
  expect(mocks.insert).toHaveBeenLastCalledWith(scope, expect.objectContaining({ assistance: "revealed", answer: "original" }), { submittedAssistance: "independent" });
  expect(mocks.knowledge).not.toHaveBeenCalled();
});
it("leaves the pre-existing normalized request semantics unchanged for legacy span sessions", async () => {
  mocks.spanLesson.mockResolvedValue(null);
  await createOpeningAttemptService(mocks.sql as unknown as Sql).submit(scope, id, body);
  expect(mocks.insert).toHaveBeenCalledWith(scope, expect.objectContaining({ assistance: "hinted" }), { workSource: undefined });
});
