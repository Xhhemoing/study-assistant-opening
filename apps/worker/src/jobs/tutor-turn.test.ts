import { describe, expect, it, vi } from "vitest";
import { OpeningProviderError } from "@aistudy/ai";
import type { SourceChunk } from "@aistudy/contracts";
import { PrivacyEpochError } from "../runtime/privacy-guard";
import { DEFAULT_STRATEGY_TEMPLATE_ID } from "@aistudy/domain";
import { createTutorTurnHandler, isImageOnlySourceChunks, makeTutorInstruction, VISION_REQUIRED_MESSAGE } from "./tutor-turn";

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
  const turn = { text: "explain the laws of motion", mode: "explain", sourceIds: [chunkA.sourceId], currentPage: 1, chunkId: chunkA.id, learningSessionId: null as string | null, strategyTemplateId: null as string | null };
  const claimedJob = { id: "00000000-0000-4000-8000-00000000000j", workspaceId: "00000000-0000-4000-8000-000000000002", ownerUserId: "00000000-0000-4000-8000-000000000003", conversationId: "00000000-0000-4000-8000-000000000004", userTurnId: "00000000-0000-4000-8000-000000000005", assistantTurnId: "00000000-0000-4000-8000-000000000006", status: "running" as const, mode: "explain", error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

  function setup(overrides: { claim?: unknown; chunks?: SourceChunk[]; provider?: unknown; sourceIds?: string[]; sourceVersions?: Record<string, number>; missingSourceIds?: string[] } = {}) {
    const tutorJobs = {
      claim: vi.fn(async () => (overrides.claim !== undefined ? overrides.claim : claimedJob)),
      getUserTurn: vi.fn(async () => ({ ...turn, sourceIds: overrides.sourceIds ?? turn.sourceIds, sourceVersions: overrides.sourceVersions ?? { [chunkA.sourceId]: 0 } })),
      loadHistoryContext: vi.fn(async () => ({ history: [{ role: "user" as const, text: "yesterday" }, { role: "assistant" as const, text: "step two" }], sourceRefs: [] as Array<{ sourceId: string; sourceVersion: number }> })),
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

  it("passes authorized version-pinned page images to a visual model and keeps citations", async () => {
    const { deps, provider, tutorJobs } = setup();
    const image = { mediaType: "image/png" as const, data: "data:image/png;base64,aGVsbG8=", sourceId: chunkA.sourceId, physicalPage: 1 };
    const pageImages = vi.fn(async () => [image]);
    await createTutorTurnHandler({ ...deps, resolveModel: async () => ({ provider, supportsVision: true, modelSnapshot: { id: "visual", providerId: "p", modelName: "v", inputCentsPerMillion: 100, outputCentsPerMillion: 200 }, inputCentsPerMillion: 100, outputCentsPerMillion: 200 }), pageImages })(claimedJob.id);
    expect(pageImages).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: claimedJob.workspaceId }), expect.objectContaining({ sourceIds: [chunkA.sourceId], sourceVersions: { [chunkA.sourceId]: 0 }, physicalPage: 1 }));
    expect(provider.complete.mock.calls[0]![0]).toMatchObject({ mediaCapability: "text_plus_page_images", imageParts: [image] });
    expect(tutorJobs.completeTurn).toHaveBeenCalled();
  });

  it("rejects image-only sources when the model cannot see images without reserving budget", async () => {
    const imageChunk: SourceChunk = { ...chunkA, text: "", imageObjectKey: "sources/photo.png" };
    const { deps, provider, budget, tutorJobs } = setup({ chunks: [imageChunk] });
    const resolveModel = vi.fn(async () => ({
      provider, supportsVision: false,
      modelSnapshot: { id: "text", providerId: "p", modelName: "t", inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
      inputCentsPerMillion: 100, outputCentsPerMillion: 200,
    }));
    await expect(createTutorTurnHandler({ ...deps, resolveModel })(claimedJob.id)).rejects.toThrow(VISION_REQUIRED_MESSAGE);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalledWith(expect.anything(), claimedJob.id, VISION_REQUIRED_MESSAGE);
  });

  it("attaches page 1 for image-only sources on a vision model even without currentPage", async () => {
    const imageChunk: SourceChunk = { ...chunkA, text: "", imageObjectKey: "sources/photo.png" };
    const { deps, provider, tutorJobs } = setup({ chunks: [imageChunk] });
    tutorJobs.getUserTurn = vi.fn(async () => ({ ...turn, currentPage: null, sourceVersions: { [chunkA.sourceId]: 0 } }));
    const image = { mediaType: "image/png" as const, data: "data:image/png;base64,aGVsbG8=", sourceId: chunkA.sourceId, physicalPage: 1 };
    const pageImages = vi.fn(async () => [image]);
    await createTutorTurnHandler({
      ...deps,
      resolveModel: async () => ({
        provider, supportsVision: true,
        modelSnapshot: { id: "visual", providerId: "p", modelName: "v", inputCentsPerMillion: 100, outputCentsPerMillion: 200 },
        inputCentsPerMillion: 100, outputCentsPerMillion: 200,
      }),
      pageImages,
    })(claimedJob.id);
    expect(pageImages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ physicalPage: 1 }));
    expect(provider.complete.mock.calls[0]![0]).toMatchObject({ mediaCapability: "text_plus_page_images", imageParts: [image] });
    expect(tutorJobs.completeTurn).toHaveBeenCalled();
  });

  it("isImageOnlySourceChunks requires image keys and empty text", () => {
    expect(isImageOnlySourceChunks([])).toBe(false);
    expect(isImageOnlySourceChunks([chunkA])).toBe(false);
    expect(isImageOnlySourceChunks([{ ...chunkA, text: "", imageObjectKey: "k" }])).toBe(true);
    expect(isImageOnlySourceChunks([{ ...chunkA, text: "  ", imageObjectKey: "k" }])).toBe(true);
    expect(isImageOnlySourceChunks([{ ...chunkA, text: "caption", imageObjectKey: "k" }])).toBe(false);
  });

    it("uses one resolved model for provider dispatch, prices and ledger attribution", async () => {
    const { deps, provider, budget } = setup();
    const selectedProvider = { complete: vi.fn(async () => ({ text: "selected answer", citedChunkIds: [chunkA.id], candidates: [], requestId: "selected-request", inputTokens: 100, outputTokens: 50 })) };
    const modelSnapshot = { id: "selected", providerId: "other", modelName: "other-model", inputCentsPerMillion: 10_000, outputCentsPerMillion: 20_000 };
    const resolveModel = vi.fn(async () => ({ provider: selectedProvider, modelSnapshot, ...modelSnapshot }));
    await createTutorTurnHandler({ ...deps, resolveModel })(claimedJob.id);
    expect(resolveModel).toHaveBeenCalledWith({ workspaceId: claimedJob.workspaceId, ownerUserId: claimedJob.ownerUserId }, "explain");
    expect(selectedProvider.complete).toHaveBeenCalledOnce();
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestId: `tutor:${claimedJob.id}`, modelSnapshot }));
    expect(budget.settle).toHaveBeenCalledWith("res-1", 2);
  });

  it("BC1: same tutor job retries reuse one ledger reservation (operationId)", async () => {
    // Fake ledger mirrors opening-budget idempotency by requestId (operationId key).
    const reservations: { requestId: string; id: string }[] = [];
    const budget = {
      reserve: vi.fn(async (_scope: unknown, input: { requestId: string }) => {
        const hit = reservations.find((r) => r.requestId === input.requestId);
        if (hit) return { id: hit.id };
        const id = `res-${reservations.length + 1}`;
        reservations.push({ requestId: input.requestId, id });
        return { id };
      }),
      release: vi.fn(async () => ({})),
      settle: vi.fn(async () => ({})),
      markUnknown: vi.fn(async () => ({})),
    };
    const { deps, tutorJobs } = setup({
      provider: async () => {
        throw new OpeningProviderError("PROVIDER_UNAVAILABLE", "down", true);
      },
    });
    deps.budget = budget;
    await expect(createTutorTurnHandler(deps)(claimedJob.id)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(budget.markUnknown).toHaveBeenCalledWith("res-1");
    expect(budget.reserve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requestId: `tutor:${claimedJob.id}` }),
    );
    // Second attempt of the same durable job: claim again, reuse reserve key.
    tutorJobs.claim.mockResolvedValueOnce(claimedJob);
    budget.settle.mockClear();
    const okProvider = { complete: vi.fn(async () => ({ text: "retry ok", citedChunkIds: [chunkA.id], requestId: null, candidates: [], inputTokens: 10, outputTokens: 5 })) };
    deps.provider = okProvider;
    await createTutorTurnHandler(deps)(claimedJob.id);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.requestId).toBe(`tutor:${claimedJob.id}`);
    expect(budget.settle).toHaveBeenCalledWith("res-1", expect.any(Number));
    expect(okProvider.complete).toHaveBeenCalledOnce();
  });

  it("does not dispatch or reserve when route resolution fails", async () => {
    const { deps, provider, budget, tutorJobs } = setup();
    const resolveModel = vi.fn(async () => { throw new Error("selected model removed"); });
    await expect(createTutorTurnHandler({ ...deps, resolveModel })(claimedJob.id)).rejects.toThrow("selected model removed");
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalledWith(expect.anything(), claimedJob.id, "selected model removed");
  });
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

  it("Package C: explicit large sourceIds are not top-K narrowed on the worker", async () => {
    // Seven sources all match the query. If pick ran, only 6 would reach selectContext.
    const sources = Array.from({ length: 7 }, (_, i) => {
      const sourceId = `00000000-0000-4000-8000-0000000001${i}0`;
      const chunk: SourceChunk = {
        id: `00000000-0000-4000-8000-0000000002${i}0`,
        sourceId,
        sourceVersion: 0,
        page: 1,
        slideLabel: null,
        startMs: null,
        endMs: null,
        text: `shared keyword alpha for source ${i}`,
        imageObjectKey: null,
      };
      return { sourceId, chunk };
    });
    const { deps, provider } = setup({
      chunks: sources.map((row) => row.chunk),
      sourceIds: sources.map((row) => row.sourceId),
      sourceVersions: Object.fromEntries(sources.map((row) => [row.sourceId, 0])),
      provider: async () => ({
        text: "ok",
        citedChunkIds: [],
        requestId: null,
        candidates: [],
        inputTokens: 10,
        outputTokens: 5,
      }),
    });
    deps.config.maxContextCharacters = 50_000;
    deps.tutorJobs.getUserTurn = vi.fn(async () => ({
      ...turn,
      text: "alpha",
      currentPage: null,
      chunkId: null,
      sourceIds: sources.map((row) => row.sourceId),
      sourceVersions: Object.fromEntries(sources.map((row) => [row.sourceId, 0])),
    }));
    await createTutorTurnHandler(deps)(claimedJob.id);
    const sent = provider.complete.mock.calls[0]![0]!;
    const sourceIdsInContext = new Set(sent.chunks.map((row: { sourceId: string }) => row.sourceId));
    expect(sourceIdsInContext.size).toBe(7);
  });

  it("Package C: vague query still passes non-empty context to the provider when chunks exist", async () => {
    const vagueChunk: SourceChunk = {
      ...chunkA,
      text: "课程绪论：本周学习目标与练习安排",
    };
    const { deps, provider } = setup({
      chunks: [vagueChunk],
      provider: async () => ({
        text: "一般说明",
        citedChunkIds: [],
        requestId: null,
        candidates: [],
        inputTokens: 10,
        outputTokens: 5,
      }),
    });
    deps.tutorJobs.getUserTurn = vi.fn(async () => ({
      ...turn,
      text: "这道题怎么做？",
      currentPage: null,
      chunkId: null,
      sourceIds: [vagueChunk.sourceId],
      sourceVersions: { [vagueChunk.sourceId]: 0 },
    }));
    await createTutorTurnHandler(deps)(claimedJob.id);
    const sent = provider.complete.mock.calls[0]![0]!;
    expect(sent.chunks.length).toBeGreaterThan(0);
    expect(sent.chunks[0]?.id).toBe(vagueChunk.id);
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
        return calls <= 2 ? 1 : 2;
      }),
      listExcludedSourceIds: vi.fn(async () => []),
    };
    await expect(createTutorTurnHandler({ ...deps, privacy })(claimedJob.id)).rejects.toBeInstanceOf(PrivacyEpochError);
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
    expect(tutorJobs.fail).toHaveBeenCalled();
  });

  it("does not send stale context and releases the reservation when privacy changes before send", async () => {
    const { deps, budget, provider, tutorJobs } = setup();
    let epoch = 1;
    budget.reserve.mockImplementation(async () => { epoch = 2; return { id: "res-1" }; });
    const privacy = {
      getWorkspaceEpoch: vi.fn(async () => epoch),
      listExcludedSourceIds: vi.fn(async () => []),
    };
    await expect(createTutorTurnHandler({ ...deps, privacy })(claimedJob.id)).rejects.toBeInstanceOf(PrivacyEpochError);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(budget.release).toHaveBeenCalledWith(`tutor:${claimedJob.id}`);
    expect(budget.settle).not.toHaveBeenCalled();
    expect(tutorJobs.completeTurn).not.toHaveBeenCalled();
  });

  it("carries uncited chunks, history and injected memory references with distinct versions", async () => {
    const { deps, tutorJobs } = setup({ provider: async () => ({ text: "mixed", citedChunkIds: [
      chunkA.id],
      requestId: null, candidates: [{ kind: "memory", text: "mixed memory", temporary: false }], inputTokens: 1, outputTokens: 1 }) });
    tutorJobs.loadHistoryContext.mockResolvedValue({ history: [], sourceRefs: [{ sourceId: secondSourceId, sourceVersion: 1 }] });
    const memories = { listContext: vi.fn(async () => ({ sourceRefs: [{ sourceId: secondSourceId, sourceVersion: 2 }], memories: [] })) };
    await createTutorTurnHandler({ ...deps, memories })(claimedJob.id);
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      contextSourceRefs: [
        { sourceId: chunkA.sourceId, sourceVersion: 0 },
        { sourceId: secondSourceId, sourceVersion: 1 },
        { sourceId: secondSourceId, sourceVersion: 2 },
      ],
      candidates: [{ payload: { kind: "memory", text: "mixed memory", temporary: false }, sourceIds: [chunkA.sourceId, secondSourceId] }],
    }));
  });
  it("passes the job privacy epoch into completeTurn on the success path", async () => {
    const { deps, tutorJobs } = setup();
    const privacy = {
      getWorkspaceEpoch: vi.fn(async () => 7),
      listExcludedSourceIds: vi.fn(async () => []),
    };

    await createTutorTurnHandler({ ...deps, privacy })(claimedJob.id);

    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      expectedPrivacyEpoch: 7,
    }));
  });

  it("records a definitive failure (not unknown) when completeTurn rejects on privacy epoch drift", async () => {
    const { deps, tutorJobs, budget } = setup();
    const privacy = {
      getWorkspaceEpoch: vi.fn(async () => 7),
      listExcludedSourceIds: vi.fn(async () => []),
    };
    tutorJobs.completeTurn.mockRejectedValueOnce(
      Object.assign(new Error("privacy epoch drift: expected 7 current 8"), { code: "CONFLICT" }),
    );

    await expect(createTutorTurnHandler({ ...deps, privacy })(claimedJob.id)).rejects.toThrow(/privacy epoch drift/);

    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ expectedPrivacyEpoch: 7 }));
    expect(tutorJobs.fail).toHaveBeenCalledWith(expect.anything(), claimedJob.id, "privacy epoch drift: expected 7 current 8");
    expect(tutorJobs.markUnknown).not.toHaveBeenCalled();
    expect(budget.markUnknown).not.toHaveBeenCalled();
  });

  it("puts confirmed memory into the provider instruction and omits candidates", async () => {
    const { deps, provider } = setup();
    const memories = {
      listContext: vi.fn(async () => ({ sourceRefs: [], memories: [
        { id: "m1", workspaceId: "w", kind: "candidate" as const, text: "待确认偏好", sourceTurnIds: [], version: 1, expiresAt: null, status: "active" as const, createdAt: "2026-09-12T00:00:00Z" },
        { id: "m2", workspaceId: "w", kind: "confirmed" as const, text: "先看例题再问结论", sourceTurnIds: ["00000000-0000-4000-8000-000000000099"], version: 1, expiresAt: null, status: "active" as const, createdAt: "2026-09-12T00:00:00Z" },
      ] })),
    };
    await createTutorTurnHandler({ ...deps, memories })(claimedJob.id);
    const sent = provider.complete.mock.calls[0]?.[0] as { instruction: string };
    expect(sent.instruction).toContain("先看例题再问结论");
    expect(sent.instruction).not.toContain("待确认偏好");
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

  it("injects the selected strategy suffix without changing mode instruction", async () => {
    const { deps, provider } = setup();
    deps.tutorJobs.getUserTurn = vi.fn(async () => ({
      ...turn, sourceVersions: { [chunkA.sourceId]: 0 },
      strategyTemplateId: DEFAULT_STRATEGY_TEMPLATE_ID,
    }));

    await createTutorTurnHandler(deps)(claimedJob.id);
    const input = provider.complete.mock.calls[0]![0] as { instruction: string };
    expect(input.instruction).toContain(makeTutorInstruction("explain"));
    expect(input.instruction).toContain("所有结论必须锚定所选材料的具体物理页");
  });

  it("falls back to the default strategy for unknown template ids", async () => {
    const { deps, provider } = setup();
    deps.tutorJobs.getUserTurn = vi.fn(async () => ({
      ...turn, sourceVersions: { [chunkA.sourceId]: 0 },
      strategyTemplateId: "missing-template",
    }));

    await createTutorTurnHandler(deps)(claimedJob.id);
    const input = provider.complete.mock.calls[0]![0] as { instruction: string };
    expect(input.instruction).toContain(makeTutorInstruction("explain"));
    expect(input.instruction).toContain("不得编造页码");
  });

  it("completes a page-backed turn with empty cites as general (soft page guard)", async () => {
    const { deps, tutorJobs, provider } = setup({ provider: async () => ({ text: "F = ma", citedChunkIds: [], requestId: null, candidates: [], inputTokens: 1, outputTokens: 1 }) });

    await expect(createTutorTurnHandler(deps)(claimedJob.id)).resolves.toEqual({ skipped: false });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(tutorJobs.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      text: "F = ma",
      citations: [],
    }));
    expect(tutorJobs.fail).not.toHaveBeenCalled();
  });

  it("soft-filters unknown citedChunkIds and prefers on-page cites", async () => {
    const invented = "00000000-0000-4000-8000-00000000dead";
    const { deps, tutorJobs } = setup({
      chunks: [chunkA, chunkB],
      provider: async () => ({
        text: "F = ma",
        citedChunkIds: [invented, chunkB.id, chunkA.id],
        requestId: null,
        candidates: [],
        inputTokens: 1,
        outputTokens: 1,
      }),
    });

    await expect(createTutorTurnHandler(deps)(claimedJob.id)).resolves.toEqual({ skipped: false });
    const completeArg = tutorJobs.completeTurn.mock.calls[0]![0] as {
      citations: Array<{ chunkId: string; page?: number }>;
    };
    // Unknown invented id dropped; currentPage=1 → prefer chunkA only.
    expect(completeArg.citations.map((c) => c.chunkId)).toEqual([chunkA.id]);
    expect(completeArg.citations[0]).toMatchObject({ page: 1 });
  });
});
