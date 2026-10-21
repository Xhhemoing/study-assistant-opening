import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LearningAttempt, Scope, SpanProblem } from "@aistudy/contracts";
import { spanHintResponseSchema } from "@aistudy/contracts";
import { getSpanProblem, listSpanTeachingProblems, solveSpanProblem } from "@aistudy/domain";
import { listSpanReservedProblems } from "@aistudy/domain/span-heldout-catalog";
import type { Sql } from "postgres";

const mocks = vi.hoisted(() => ({ assertAccess: vi.fn(), deliver: vi.fn(), sql: vi.fn() }));
vi.mock("@aistudy/database", () => ({
  createOpeningLearningAttemptRepository: () => ({ assertAccess: mocks.assertAccess }),
  createOpeningStudyExposureRepository: () => ({ deliver: mocks.deliver }),
}));
import { createSpanHintService } from "./hint-service";

const id = "11111111-1111-4111-8111-111111111111";
const itemId = "22222222-2222-4222-8222-222222222222";
const scope: Scope = { workspaceId: id, ownerUserId: id };
const catalog = [...listSpanTeachingProblems(), ...listSpanReservedProblems()];
const service = createSpanHintService(mocks.sql as unknown as Sql);
function attempt(problem: SpanProblem, sealed = false): LearningAttempt {
  return { id, workspaceId: id, sessionId: id, courseId: id, skillLabel: "span", requirementKey: "span:linear-combination:v1",
    problemId: id, itemVersionId: itemId, sourceIds: [id], sourceVersions: { [id]: 1 }, startedAt: "2026-10-21T00:00:00Z",
    submittedAt: sealed ? "2026-10-21T00:01:00Z" : null, observationId: sealed ? id : null, historyRevision: 1, spanExercise: problem };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertAccess.mockResolvedValue(attempt(getSpanProblem("span-faded-3d")!));
  mocks.sql.mockResolvedValue([{ answer: JSON.stringify({ membership: "not_in_span" }) }]);
  mocks.deliver.mockImplementation(async (_scope, input) => ({ id, releaseKey: input.releaseKey, contextAnchor: input.contextAnchor,
    origin: input.origin, supportDomain: input.supportDomain ?? "unknown", generatedAt: "2026-10-21T00:02:00Z",
    releasedAt: "2026-10-21T00:02:00Z", acknowledgedAt: null, historyRevision: 2 }));
});

describe("span hint ladder", () => {
  it.each(catalog)("releases three distinct math hints for $id without returning its solution", async problem => {
    mocks.assertAccess.mockResolvedValue(attempt(problem));
    const responses = [];
    for (const level of [1, 2, 3] as const) {
      const response = await service.read(scope, { attemptId: id, level });
      expect(spanHintResponseSchema.parse(response)).toEqual(response);
      expect(response.level).toBe(level);
      expect(response.text).not.toContain("Sol.");
      expect(response).not.toHaveProperty("solution");
      responses.push(response);
      expect(mocks.deliver).toHaveBeenLastCalledWith(scope, expect.objectContaining({ releaseKey: `span-hint-v1:${id}:${level}`,
        contextAnchor: { attemptId: id, itemVersionId: itemId, courseId: id, purpose: "learning_help" }, sessionId: id,
        kind: "hint", level: "hinted", origin: "assistant", supportDomain: "math" }));
    }
    expect(new Set(responses.map(response => response.text)).size).toBe(3);
    expect(responses[2]!.text).toContain(`(${problem.vectors[0][0]})α+(${problem.vectors[1][0]})β=${problem.target[0]}`);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("keeps legacy requests at level 1 and gives retries the same release identity", async () => {
    const first = await service.read(scope, { attemptId: id });
    const replay = await service.read(scope, { attemptId: id, level: 1 });
    expect(first.text).toContain("αv+βw=u");
    expect(first.level).toBe(1);
    expect(replay.exposureReceipt.releaseKey).toBe(first.exposureReceipt.releaseKey);
    expect(mocks.deliver.mock.calls[0]![1]).toEqual(mocks.deliver.mock.calls[1]![1]);
  });

  it.each(catalog)("keeps level 4 behind the existing sealed-answer boundary for $id", async problem => {
    mocks.assertAccess.mockResolvedValue(attempt(problem));
    await expect(service.read(scope, { attemptId: id, level: 4 })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it.each(catalog)("releases complete version-bound working for $id after reading its immutable original", async problem => {
    mocks.assertAccess.mockResolvedValue(attempt(problem, true));
    const response = await service.read(scope, { attemptId: id, level: 4 });
    expect(spanHintResponseSchema.parse(response)).toEqual(response);
    expect(response.level).toBe(4);
    expect(response.text).toContain("Sol.");
    const solution = solveSpanProblem(problem);
    if (solution.kind === "none") expect(response.text).toContain("u ∉ span{v,w}");
    else if (solution.kind === "unique") expect(response.text).toContain(`α=${solution.coefficients[0]}, β=${solution.coefficients[1]}`);
    else if (solution.kind === "infinite") expect(response.text).toContain(`(α,β)=(${solution.particular.join(",")})`);
    else throw new Error("Known catalog item must have an exact solution");
    expect(mocks.sql).toHaveBeenCalledOnce();
    expect(mocks.deliver).toHaveBeenCalledWith(scope, expect.objectContaining({ releaseKey: `span-feedback:${id}`,
      kind: "solution", level: "revealed", origin: "history_solution", contextAnchor: { attemptId: id, itemVersionId: itemId, courseId: id, purpose: "history_solution" } }));
    expect(response).not.toHaveProperty("independent");
    expect(response).not.toHaveProperty("retestScheduled");
  });

  it("requires the persisted original record even when an attempt carries submitted metadata", async () => {
    mocks.assertAccess.mockResolvedValue(attempt(getSpanProblem("span-faded-3d")!, true));
    mocks.sql.mockResolvedValueOnce([]);
    await expect(service.read(scope, { attemptId: id, level: 4 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("does not return hint content when access or the durable release fails", async () => {
    mocks.assertAccess.mockRejectedValueOnce(Object.assign(new Error("not owned"), { code: "NOT_FOUND" }));
    await expect(service.read(scope, { attemptId: id, level: 3 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.deliver).not.toHaveBeenCalled();
    mocks.deliver.mockRejectedValueOnce(new Error("release failed"));
    await expect(service.read(scope, { attemptId: id, level: 3 })).rejects.toThrow("release failed");
  });

  it("does not expose a worked solution for unknown versions or non-span attempts", async () => {
    const current = attempt(getSpanProblem("span-faded-3d")!, true);
    mocks.assertAccess.mockResolvedValueOnce({ ...current, spanExercise: undefined });
    await expect(service.read(scope, { attemptId: id })).rejects.toMatchObject({ code: "VALIDATION" });
    mocks.assertAccess.mockResolvedValueOnce({ ...current, spanExercise: { ...current.spanExercise!, version: "2" } });
    await expect(service.read(scope, { attemptId: id, level: 4 })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});
