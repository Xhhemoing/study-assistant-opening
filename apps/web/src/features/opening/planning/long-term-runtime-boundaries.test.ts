import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { getLongTermPlanningService } from "./long-term-runtime";
import { readLearningCardSessions, writeLearningCardSession, createOpeningLongTermPlanningRepository } from "@aistudy/database";

vi.mock("@aistudy/database", () => ({
  createOpeningLongTermPlanningRepository: vi.fn(() => ({})),
  readLearningCardSessions: vi.fn(), writeLearningCardSession: vi.fn(),
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scopes = [{ workspaceId: id(1), ownerUserId: id(2) }, { workspaceId: id(1), ownerUserId: id(3) },
  { workspaceId: id(4), ownerUserId: id(2) }];
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe("long-term runtime real card-service closures", () => {
  for (const scope of scopes) it.each([undefined, id(5)])(`readCards sql/scope isolation ${scope.workspaceId}/${scope.ownerUserId}: %j`, async cardId => {
    const left = vi.fn() as unknown as Sql, right = vi.fn() as unknown as Sql;
    const leftService = getLongTermPlanningService(left), rightService = getLongTermPlanningService(right);
    const result = [] as unknown as Awaited<ReturnType<typeof readLearningCardSessions>>;
    vi.mocked(readLearningCardSessions).mockResolvedValue(result);
    expect(await rightService.readCards(scope, cardId)).toBe(result);
    expect(await leftService.readCards(scope, cardId)).toBe(result);
    expect(readLearningCardSessions).toHaveBeenNthCalledWith(1, right, scope, cardId);
    expect(readLearningCardSessions).toHaveBeenNthCalledWith(2, left, scope, cardId);
    expect(writeLearningCardSession).not.toHaveBeenCalled();
  });
  for (const scope of scopes) it.each([
    { action: "start", budgetMinutes: 5, cardIds: [id(5)], clientKey: "real-card-start" },
    { action: "stop", activityId: id(6), expectedRevision: 2, elapsedSeconds: 61, reviewedCardIds: [id(5)], reason: "pause" },
  ])(`writeCards originating sql and scope ${scope.workspaceId}/${scope.ownerUserId}: %j`, async raw => {
    const sql = vi.fn() as unknown as Sql;
    const result = { sentinel: true } as unknown as Awaited<ReturnType<typeof writeLearningCardSession>>;
    vi.mocked(writeLearningCardSession).mockResolvedValue(result);
    expect(await getLongTermPlanningService(sql).writeCards(scope, raw)).toBe(result);
    expect(writeLearningCardSession).toHaveBeenCalledExactlyOnceWith(sql, scope, raw.action === "start" ? { ...raw, goalIds: [] } : raw);
    expect(readLearningCardSessions).not.toHaveBeenCalled();
  });
  it.each(["read", "write"])("%s callback preserves actual repository rejection", async operation => {
    const error = Object.assign(new Error("card dependency denied"), { code: "FORBIDDEN" });
    const service = getLongTermPlanningService(vi.fn() as unknown as Sql);
    vi.mocked(readLearningCardSessions).mockRejectedValue(error);
    vi.mocked(writeLearningCardSession).mockRejectedValue(error);
    const scope = scopes[0]!;
    await expect(operation === "read" ? service.readCards(scope, id(5)) : service.writeCards(scope, {
      action: "stop", activityId: id(6), expectedRevision: 1, elapsedSeconds: 0, reviewedCardIds: [], reason: "finished",
    })).rejects.toBe(error);
  });
  it.each(["read", "write"])("%s fails closed before callback on invalid input", operation => {
    const service = getLongTermPlanningService(vi.fn() as unknown as Sql), scope = scopes[0]!;
    expect(() => operation === "read" ? service.readCards(scope, "foreign-not-uuid") : service.writeCards(scope, {
      action: "stop", activityId: id(6), expectedRevision: 0, elapsedSeconds: -1, reviewedCardIds: [], reason: "finished",
    })).toThrow();
    expect(readLearningCardSessions).not.toHaveBeenCalled();
    expect(writeLearningCardSession).not.toHaveBeenCalled();
  });
  it("propagates factory construction failure before exposing a service", () => {
    const error = new Error("repository factory unavailable");
    vi.mocked(createOpeningLongTermPlanningRepository).mockImplementationOnce(() => { throw error; });
    expect(() => getLongTermPlanningService(vi.fn() as unknown as Sql)).toThrow(error);
    expect(readLearningCardSessions).not.toHaveBeenCalled();
    expect(writeLearningCardSession).not.toHaveBeenCalled();
  });
});
