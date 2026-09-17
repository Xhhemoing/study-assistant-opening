import { describe, expect, it, vi } from "vitest";
import { OpeningProviderError } from "@aistudy/ai";
import type { SourceChunk } from "@aistudy/contracts";
import { createTutorTurnHandler, makeTutorInstruction } from "./tutor-turn";

describe("tutor mode policy", () => {
  it("keeps listening distinct from unsolicited planning", () => {
    expect(makeTutorInstruction("listen")).toContain("不要自动创建任务");
  });
  it("makes hints focus on the next step", () => {
    expect(makeTutorInstruction("hint")).toContain("下一步提示");
  });
  it("allows full answers only in explain mode", () => {
    expect(makeTutorInstruction("explain")).toContain("完整答案");
  });
  it("describes collaborative thinking", () => {
    expect(makeTutorInstruction("think_together")).toContain("共同思考");
  });
});

describe("tutor turn handler", () => {
  const chunkA: SourceChunk = { id: "00000000-0000-4000-8000-00000000000a", sourceId: "00000000-0000-4000-8000-000000000001", sourceVersion: 0, page: 1, slideLabel: null, startMs: null, endMs: null, text: "Newton wrote the laws of motion", imageObjectKey: null };
  const chunkB: SourceChunk = { ...chunkA, id: "00000000-0000-4000-8000-00000000000b", page: 2, text: "Einstein refined gravity" };
  const turn = { text: "explain the laws of motion", mode: "explain", sourceIds: ["00000000-0000-4000-8000-000000000001"], currentPage: 1, chunkId: chunkA.id };
  const claimedJob = { id: "00000000-0000-4000-8000-00000000000j", workspaceId: "00000000-0000-4000-8000-000000000002", ownerUserId: "00000000-0000-4000-8000-000000000003", conversationId: "00000000-0000-4000-8000-000000000004", userTurnId: "00000000-0000-4000-8000-000000000005", assistantTurnId: "00000000-0000-4000-8000-000000000006", status: "running" as const, mode: "explain", error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

  function setup(overrides: { claim?: unknown; chunks?: SourceChunk[]; provider?: unknown } = {}) {
    const tutorJobs = {
      claim: vi.fn(async () => (overrides.claim !== undefined ? overrides.claim : claimedJob)),
      getUserTurn: vi.fn(async () => turn),
      completeTurn: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      markUnknown: vi.fn(async () => undefined),
    };
    const chunks = { listForSources: vi.fn(async () => overrides.chunks ?? [chunkA, chunkB]) };
    const budget = {
      reserve: vi.fn(async () => ({ id: "res-1" })),
      release: vi.fn(async () => ({})),
      settle: vi.fn(async () => ({})),
      markUnknown: vi.fn(async () => ({})),
    };
    const provider = { complete: vi.fn(overrides.provider ?? (async () => ({ text: "F = ma", citedChunkIds: [chunkA.id], requestId: null, candidates: [{ kind: "memory", text: "Learner asked about Newton", temporary: false }], inputTokens: 100, outputTokens: 50 }))) };
    const deps = { tutorJobs, chunks, budget, provider, config: { maxContextCharacters: 5000, reservedCents: 100, maxOutputTokens: 2048, inputCentsPerMillion: 100, outputCentsPerMillion: 200 } };
    return { deps, tutorJobs, chunks, budget, provider };
  }

  it("completes the turn once with program-assigned candidate provenance", async () => {
    const { deps, tutorJobs, budget, provider } = setup();
    const result = await createTutorTurnHandler(deps)(claimedJob.id);
    expect(result).toEqual({ skipped: false });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    const input = provider.complete.mock.calls[0][0];
    expect(input.chunks[0].id).toBe(chunkA.id);
    expect(input.instruction).toContain("完整答案");
    expect(budget.settle).toHaveBeenCalledWith("res-1", expect.any(Number));
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ jobId: claimedJob.id, assistantTurnId: claimedJob.assistantTurnId, text: "F = ma", candidates: [expect.objectContaining({ sourceIds: [chunkA.sourceId] })] }));
  });

  it("skips a redelivered job without calling the provider", async () => {
    const { deps, provider, budget } = setup({ claim: null });
    await expect(createTutorTurnHandler(deps)(claimedJob.id)).resolves.toEqual({ skipped: true });
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it("marks the job unknown and retains the reservation on provider timeouts", async () => {
    const { deps, tutorJobs, budget } = setup({ provider: async () => { throw new OpeningProviderError("PROVIDER_TIMEOUT", "timed out", 0); } });
    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toThrow();
    expect(budget.markUnknown).toHaveBeenCalledWith("res-1");
    expect(tutorJobs.markUnknown).toHaveBeenCalled();
    expect(tutorJobs.fail).not.toHaveBeenCalled();
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
  });

  it("fails definitively and releases on provider auth errors", async () => {
    const { deps, tutorJobs, budget } = setup({ provider: async () => { throw new OpeningProviderError("PROVIDER_AUTH", "bad key", 401); } });
    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toThrow();
    expect(budget.release).toHaveBeenCalledWith(`tutor:${claimedJob.id}`);
    expect(tutorJobs.fail).toHaveBeenCalled();
    expect(tutorJobs.markUnknown).not.toHaveBeenCalled();
  });

  it("fails honestly when every requested source vanished", async () => {
    const { deps, tutorJobs, provider, budget } = setup({ chunks: [] });
    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toThrow(/unavailable/);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalled();
  });

  it("fails content-free when the budget cap rejects the reservation", async () => {
    const { deps, tutorJobs, provider, budget } = setup();
    budget.reserve.mockRejectedValueOnce(new Error("BUDGET_EXCEEDED"));
    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toThrow(/BUDGET_EXCEEDED/);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalled();
  });
});
