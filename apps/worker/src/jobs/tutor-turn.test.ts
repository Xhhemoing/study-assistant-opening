import { describe, expect, it, vi } from "vitest";
import { OpeningProviderError } from "@aistudy/ai";
import type { SourceChunk } from "@aistudy/contracts";
import { PrivacyEpochError } from "../runtime/privacy-guard";
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
  const secondSourceId = "00000000-0000-4000-8000-000000000007";
  const chunkC: SourceChunk = { ...chunkA, id: "00000000-0000-4000-8000-00000000000c", sourceId: secondSourceId, text: "Momentum is conserved" };
  const turn = { text: "explain the laws of motion", mode: "explain", sourceIds: [chunkA.sourceId], currentPage: 1, chunkId: chunkA.id, learningSessionId: null as string | null };
  const claimedJob = { id: "00000000-0000-4000-8000-00000000000j", workspaceId: "00000000-0000-4000-8000-000000000002", ownerUserId: "00000000-0000-4000-8000-000000000003", conversationId: "00000000-0000-4000-8000-000000000004", userTurnId: "00000000-0000-4000-8000-000000000005", assistantTurnId: "00000000-0000-4000-8000-000000000006", status: "running" as const, mode: "explain", error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

  function setup(overrides: { claim?: unknown; chunks?: SourceChunk[]; provider?: unknown; sourceIds?: string[]; sourceVersions?: Record<string, number>; missingSourceIds?: string[] } = {}) {
    const tutorJobs = {
      claim: vi.fn(async () => (overrides.claim !== undefined ? overrides.claim : claimedJob)),
      getUserTurn: vi.fn(async () => ({ ...turn, sourceIds: overrides.sourceIds ?? turn.sourceIds, sourceVersions: overrides.sourceVersions ?? { [chunkA.sourceId]: 0 } })),
      loadHistory: vi.fn(async () => [{ role: "user" as const, text: "yesterday" }, { role: "assistant" as const, text: "step two" }]),
      completeTurn: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      markUnknown: vi.fn(async () => undefined),
    };
    const chunks = {
      listForSources: vi.fn(async () => overrides.chunks ?? [chunkA, chunkB]),
      listChunksAtVersion: vi.fn(async (_scope, sourceId) => overrides.missingSourceIds?.includes(sourceId)
        ? []
        : overrides.chunks ?? (sourceId === secondSourceId ? [chunkC] : [chunkA, chunkB])),
    };
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
    expect(input.history).toEqual([{ role: "user", text: "yesterday" }, { role: "assistant", text: "step two" }]);
    expect(input.instruction).toContain("完整答案");
    expect(budget.settle).toHaveBeenCalledWith("res-1", expect.any(Number));
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ jobId: claimedJob.id, assistantTurnId: claimedJob.assistantTurnId, text: "F = ma", candidates: [expect.objectContaining({ sourceIds: [chunkA.sourceId] })] }));
    expect(tutorJobs.completeTurn.mock.calls[0][0]).not.toHaveProperty("helpExposure");
  });

  it("retrieves chunks at each turn's saved source version instead of the current source version", async () => {
    const snapshotChunk = { ...chunkA, sourceVersion: 4, text: "Newton's laws from the saved source version" };
    const { deps, chunks, provider } = setup({
      chunks: [snapshotChunk],
      sourceVersions: { [chunkA.sourceId]: 4 },
    });

    await createTutorTurnHandler(deps)(claimedJob.id);

    expect(chunks.listChunksAtVersion).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId }),
      chunkA.sourceId,
      4,
    );
    expect(chunks.listForSources).not.toHaveBeenCalled();
    expect(provider.complete.mock.calls[0][0].chunks).toEqual([snapshotChunk]);
  });

  it("retrieves and merges each selected source at its saved version", async () => {
    const { deps, chunks, provider } = setup({
      sourceIds: [chunkA.sourceId, secondSourceId],
      sourceVersions: { [chunkA.sourceId]: 3, [secondSourceId]: 9 },
    });

    await createTutorTurnHandler(deps)(claimedJob.id);

    expect(chunks.listChunksAtVersion).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId }),
      chunkA.sourceId,
      3,
    );
    expect(chunks.listChunksAtVersion).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId }),
      secondSourceId,
      9,
    );
    expect(provider.complete.mock.calls[0][0].chunks.map((chunk: SourceChunk) => chunk.id)).toEqual([
      chunkA.id,
      chunkC.id,
      chunkB.id,
    ]);
  });

  it("does not fall back to the current source version when a turn has no snapshot", async () => {
    const { deps, chunks, provider, tutorJobs } = setup({ sourceVersions: {} });

    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toThrow(/unavailable/);

    expect(chunks.listChunksAtVersion).not.toHaveBeenCalled();
    expect(chunks.listForSources).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalled();
  });

  it("fails the whole mixed snapshot when one selected source has no saved version", async () => {
    const { deps, provider, tutorJobs, chunks } = setup({
      sourceIds: [chunkA.sourceId, secondSourceId],
      sourceVersions: { [chunkA.sourceId]: 3 },
    });

    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toThrow(/missing snapshot/);

    expect(chunks.listChunksAtVersion).toHaveBeenCalledTimes(1);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalled();
  });

  it("does not call the provider when one selected source snapshot is missing", async () => {
    const { deps, provider, tutorJobs } = setup({
      sourceIds: [chunkA.sourceId, secondSourceId],
      sourceVersions: { [chunkA.sourceId]: 3, [secondSourceId]: 9 },
      missingSourceIds: [secondSourceId],
    });

    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toThrow(/unavailable/);

    expect(provider.complete).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalled();
  });

  it("does not require a snapshot for a privacy-excluded source", async () => {
    const { deps, chunks, provider } = setup({
      sourceIds: [chunkA.sourceId, secondSourceId],
      sourceVersions: { [chunkA.sourceId]: 3 },
    });
    deps.privacy = {
      getWorkspaceEpoch: vi.fn(async () => 1),
      listExcludedSourceIds: vi.fn(async () => [secondSourceId]),
    };

    await createTutorTurnHandler(deps)(claimedJob.id);

    expect(chunks.listChunksAtVersion).toHaveBeenCalledTimes(1);
    expect(chunks.listChunksAtVersion).toHaveBeenCalledWith(
      expect.anything(),
      chunkA.sourceId,
      3,
    );
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it("keeps empty sourceIds as a provider-backed free exchange", async () => {
    const { deps, chunks, provider } = setup({ sourceIds: [], sourceVersions: {}, provider: async () => ({ text: "F = ma", citedChunkIds: [], requestId: null, candidates: [], inputTokens: 100, outputTokens: 50 }) });

    await createTutorTurnHandler(deps)(claimedJob.id);

    expect(chunks.listChunksAtVersion).not.toHaveBeenCalled();
    expect(chunks.listForSources).not.toHaveBeenCalled();
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it("reserves for actual input size and output limit, not only the fixed floor", async () => {
    const { deps, budget } = setup();
    deps.config.reservedCents = 1;
    deps.config.inputCentsPerMillion = 1_000_000;
    deps.config.outputCentsPerMillion = 1_000_000;
    await createTutorTurnHandler(deps)(claimedJob.id);
    expect(budget.reserve.mock.calls[0][1].amountCents).toBeGreaterThan(2048);
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

  it("rejects writeback when workspace privacy epoch changes mid-job", async () => {
    const { deps, tutorJobs } = setup();
    let calls = 0;
    const privacy = {
      getWorkspaceEpoch: vi.fn(async () => {
        calls += 1;
        return calls === 1 ? 1 : 2;
      }),
      listExcludedSourceIds: vi.fn(async () => []),
    };
    await expect(createTutorTurnHandler({ ...deps, privacy })(claimedJob.id)).rejects.toBeInstanceOf(PrivacyEpochError);
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalled();
  });

  it("passes delivered help exposure to completeTurn after assistant persistence", async () => {
    const sessionId = "00000000-0000-4000-8000-0000000000aa";
    const { deps, tutorJobs } = setup();
    deps.tutorJobs.getUserTurn = vi.fn(async () => ({
      ...turn,
      mode: "hint",
      learningSessionId: sessionId,
      sourceVersions: { [chunkA.sourceId]: 0 },
    }));
    const claimed = { ...claimedJob, mode: "hint" };
    deps.tutorJobs.claim = vi.fn(async () => claimed);
    await createTutorTurnHandler(deps)(claimed.id);
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      helpExposure: expect.objectContaining({
        sessionId,
        turnId: claimed.assistantTurnId,
        level: "hinted",
        delivered: true,
      }),
    }));
  });

  it("does not expose help when completeTurn rejects before persistence", async () => {
    const sessionId = "00000000-0000-4000-8000-0000000000aa";
    const { deps, tutorJobs } = setup();
    deps.tutorJobs.getUserTurn = vi.fn(async () => ({
      ...turn,
      mode: "hint",
      learningSessionId: sessionId,
      sourceVersions: { [chunkA.sourceId]: 0 },
    }));
    const claimed = { ...claimedJob, mode: "hint" };
    deps.tutorJobs.claim = vi.fn(async () => claimed);
    tutorJobs.completeTurn.mockRejectedValueOnce(new Error("assistant persistence failed"));
    const learning = {
      insertHelpExposure: vi.fn(async () => undefined),
    };

    await expect(createTutorTurnHandler({ ...deps, learning })(claimed.id)).rejects.toThrow(
      "assistant persistence failed",
    );

    expect(learning.insertHelpExposure).not.toHaveBeenCalled();
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      helpExposure: expect.objectContaining({ sessionId }),
    }));
  });
});
