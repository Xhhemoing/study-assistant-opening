import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CourseKnowledgeRecordResponse, SourceChunk } from "@aistudy/contracts";
import { OpeningBudgetError, OpeningKnowledgeError, type OpeningBudgetRepository } from "@aistudy/database";

const mocks = vi.hoisted(() => ({
  authorizeChunks: vi.fn(),
  hasIndex: vi.fn(),
  search: vi.fn(),
  embed: vi.fn(),
  readMaterialPurposePin: vi.fn(),
  assertMaterialPurposePin: vi.fn(),
  getWithSync: vi.fn(),
}));
vi.mock("@aistudy/database", async original => ({ ...(await original<typeof import("@aistudy/database")>()),
  createOpeningCourseReadySourcesRepository: () => mocks,
  createOpeningKnowledgeRepository: () => mocks,
  createOpeningSourceEmbeddingsRepository: () => mocks }));
vi.mock("@aistudy/ai", async original => ({ ...(await original<typeof import("@aistudy/ai")>()), runBudgetedEmbedding: mocks.embed }));
import { createOpeningMaterialRetriever, retrievalBudgetId } from "./material-retrieval";
const config = { modelKey: "test-model:3", baseUrl: "https://models.example.test/v1", modelName: "embedding", apiKey: "test",
  dimensions: 3, inputCentsPerMillion: 1, billing: "metered" as const, dailyRequestCap: null, requestDimensions: true };
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const chunks: SourceChunk[] = [
  { id: "literal", sourceId: "source1", text: "unrelated pages", page: 1, sourceVersion: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null },
  { id: "semantic", sourceId: "source9", text: "矩阵的零空间", page: 2, sourceVersion: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null },
];
const input = { courseContext: { courseId: "owned-course", materialUse: "teaching" as const }, chunks, sourceIds: chunks.map(chunk => chunk.sourceId), query: "What is a kernel?", maxCharacters: 1000, operationId: "saved-job" };
const sql = { begin: vi.fn() } as unknown as Parameters<typeof createOpeningMaterialRetriever>[0], budget = {} as OpeningBudgetRepository;
const emptyKnowledgeRecord = (courseId = "owned-course"): CourseKnowledgeRecordResponse => ({
  version: 0,
  snapshot: { courseId, version: 0, nodes: [], edges: [] },
  sourceVersions: {},
  sync: {
    status: "empty",
    activeJobId: null,
    lastBuiltVersion: null,
    coveredSourceVersions: {},
    eligibleSourceVersions: {},
    parsingSourceCount: 0,
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.readMaterialPurposePin.mockResolvedValue({ courseId: "owned-course", materialUse: "teaching", sources: [] });
  mocks.assertMaterialPurposePin.mockResolvedValue(undefined);
  mocks.authorizeChunks.mockImplementation(async (_scope, rows) => ({ chunks: rows, privacyEpoch: 1 }));
  mocks.hasIndex.mockResolvedValue(true);
  mocks.search.mockResolvedValue([{ chunk: chunks[1], segmentIndex: 0 }]);
  mocks.embed.mockImplementation(async options => { await options.beforeSend?.(); return { vectors: [[1, 0, 0]], inputTokens: 10, requestId: "provider" }; });
  mocks.getWithSync.mockResolvedValue(emptyKnowledgeRecord());
});

describe("shared material retriever", () => {
  it.each([undefined, { courseId: undefined, materialUse: "teaching" }, { courseId: "", materialUse: "teaching" }, { courseId: "owned-course", materialUse: "unknown" }])("fails closed for missing or unknown trusted context %#", async courseContext => {
    await expect(createOpeningMaterialRetriever(sql, budget, config)(scope, { ...input, courseContext } as never))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(mocks.readMaterialPurposePin).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
  });
  it("does not send or rank explicitly selected forbidden materials", async () => {
    mocks.readMaterialPurposePin.mockRejectedValue(Object.assign(new Error("source purpose changed"), { code: "CONFLICT" }));
    await expect(createOpeningMaterialRetriever(sql, budget, config)(scope, input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mocks.authorizeChunks).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
  });
  it("does not turn a purpose pre-send rejection into lexical success", async () => {
    mocks.assertMaterialPurposePin.mockRejectedValue(Object.assign(new Error("source purpose changed"), { code: "CONFLICT" }));
    await expect(createOpeningMaterialRetriever(sql, budget, config)(scope, input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("rechecks purpose even without an embedding config", async () => {
    mocks.assertMaterialPurposePin.mockRejectedValue(Object.assign(new Error("source purpose changed"), { code: "CONFLICT" }));
    await expect(createOpeningMaterialRetriever(sql, budget, null)(scope, input)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("keeps lexical material when the ledger refuses to move an existing embedding key", async () => {
    mocks.embed.mockRejectedValue(new OpeningBudgetError("CONFLICT", "request already consumed or changed"));
    const result = await createOpeningMaterialRetriever(sql, budget, config)(scope, { ...input, query: "零空间" });
    expect(result).toMatchObject({ mode: "lexical", chunks: [{ id: "semantic" }] });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.assertMaterialPurposePin).toHaveBeenCalledOnce();
  });
  it("retains the exact captured purpose pin for the real provider-send check", async () => {
    const result = await createOpeningMaterialRetriever(sql, budget, null)(scope, input);
    const pin = await mocks.readMaterialPurposePin.mock.results[0]!.value;
    expect(result.purposePin).toBe(pin);
    mocks.assertMaterialPurposePin.mockRejectedValue(Object.assign(new Error("changed after retrieval"), { code: "CONFLICT" }));
    await expect(result.assertCurrent()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mocks.readMaterialPurposePin).toHaveBeenCalledOnce();
    expect(mocks.assertMaterialPurposePin).toHaveBeenLastCalledWith(scope, pin);
  });
  it("keeps dense ranking and scopes the real embedding request and search to admitted sources", async () => {
    const parentBudget = { id: "study-turn:user-turn", budgetCents: 20, maxProviderCalls: 4 };
    const result = await createOpeningMaterialRetriever(sql, budget, config)(scope, { ...input, parentBudget });
    expect(result).toMatchObject({ mode: "hybrid", chunks: [{ id: "semantic" }] });
    expect(mocks.readMaterialPurposePin).toHaveBeenCalledWith(scope, { ...input.courseContext, sourceIds: input.sourceIds });
    expect(mocks.assertMaterialPurposePin).toHaveBeenCalledTimes(2);
    expect(mocks.embed).toHaveBeenCalledWith(expect.objectContaining({ inputs: [input.query], operationId: "material-query:saved-job",
      parentBudget: { ...parentBudget, id: "retrieval:study-turn:user-turn" }, timeoutMs: 2_000 }));
    expect(retrievalBudgetId("study-turn:user-turn")).toBe("retrieval:study-turn:user-turn");
    expect(retrievalBudgetId("retrieval:study-turn:user-turn")).toBe("retrieval:study-turn:user-turn");
    expect(retrievalBudgetId("retrieval:retrieval:study-turn:user-turn")).toBe("retrieval:study-turn:user-turn");
    const route = { sourceIds: input.sourceIds, chunkIds: chunks.map(chunk => chunk.id), privacyEpoch: 1 };
    expect(mocks.hasIndex).toHaveBeenCalledWith(scope, expect.objectContaining(route));
    expect(mocks.search).toHaveBeenCalledWith(scope, expect.objectContaining({ ...route, modelKey: config.modelKey, dimensions: 3 }));
  });
  it.each(["configuration", "index", "quota", "parent-budget", "parent-calls", "parent-unknown", "timeout"])("falls back to lexical material when %s is unavailable", async reason => {
    if (reason === "index") mocks.hasIndex.mockResolvedValue(false);
    if (reason === "quota") mocks.embed.mockRejectedValue(new Error("budget limit"));
    if (reason === "parent-budget") mocks.embed.mockRejectedValue(new OpeningBudgetError("PARENT_BUDGET_EXCEEDED", "parent interaction budget exceeded"));
    if (reason === "parent-calls") mocks.embed.mockRejectedValue(new OpeningBudgetError("PARENT_BUDGET_CALL_LIMIT", "parent interaction request limit reached"));
    if (reason === "parent-unknown") mocks.embed.mockRejectedValue(new OpeningBudgetError("PARENT_BUDGET_OUTCOME_UNKNOWN", "parent interaction has unknown billing; not re-sending"));
    if (reason === "timeout") mocks.embed.mockRejectedValue(new Error("embedding request timed out"));
    const result = await createOpeningMaterialRetriever(sql, budget, reason === "configuration" ? null : config)(scope, { ...input, query: "零空间" });
    expect(result).toMatchObject({ mode: "lexical", chunks: [{ id: "semantic" }] });
    if (reason === "configuration" || reason === "index") expect(mocks.embed).not.toHaveBeenCalled();
    if (reason === "timeout") expect(mocks.search).not.toHaveBeenCalled();
  });
  it("drops excluded material even when a stale dense result is returned", async () => {
    let calls = 0;
    mocks.authorizeChunks.mockImplementation(async (_scope, rows) => ({ chunks: ++calls >= 3 ? rows.filter((row: SourceChunk) => row.id !== "semantic") : rows, privacyEpoch: calls >= 3 ? 2 : 1 }));
    const result = await createOpeningMaterialRetriever(sql, budget, config)(scope, input);
    expect(result.chunks.map(row => row.id)).not.toContain("semantic");
  });
  it("rechecks privacy immediately before embedding and does not search after that check fails", async () => {
    mocks.authorizeChunks.mockResolvedValueOnce({ chunks, privacyEpoch: 1 }).mockResolvedValue({ chunks: [], privacyEpoch: 2 });
    const result = await createOpeningMaterialRetriever(sql, budget, config)(scope, input);
    expect(result).toMatchObject({ chunks: [], mode: "lexical", assertCurrent: expect.any(Function) });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.getWithSync).not.toHaveBeenCalled();
  });

  describe("course pedagogical graph reconciliation and Sparse PPR ranking", () => {
    const courseId = "00000000-0000-4000-8000-000000000010";
    const defChunk: SourceChunk = {
      id: "00000000-0000-4000-8000-000000000101",
      sourceId: "src-def",
      sourceVersion: 2,
      page: 4,
      slideLabel: null,
      startMs: null,
      endMs: null,
      text: ":::definition Inner Product\nBilinear symmetric positive-definite pairing <u, v>.\n:::",
      imageObjectKey: null,
    };
    const thmChunk: SourceChunk = {
      id: "00000000-0000-4000-8000-000000000102",
      sourceId: "src-thm",
      sourceVersion: 3,
      page: 12,
      slideLabel: null,
      startMs: null,
      endMs: null,
      text: ":::theorem Cauchy-Schwarz\nEvery vector pair satisfies the Cauchy-Schwarz inequality.\n:::",
      imageObjectKey: null,
    };
    const sealedChunk: SourceChunk = {
      id: "00000000-0000-4000-8000-000000000103",
      sourceId: "src-thm",
      sourceVersion: 3,
      page: 13,
      slideLabel: null,
      startMs: null,
      endMs: null,
      text: "Answer: Secret exam key for Cauchy-Schwarz is 42.",
      imageObjectKey: null,
    };
    const hintChunk: SourceChunk = {
      id: "00000000-0000-4000-8000-000000000104",
      sourceId: "src-thm",
      sourceVersion: 3,
      page: 14,
      slideLabel: null,
      startMs: null,
      endMs: null,
      text: "Hint: Expand ||u + t v||^2 >= 0 for Cauchy-Schwarz.",
      imageObjectKey: null,
    };

    const upToDateRecord = (targetCourseId = courseId): CourseKnowledgeRecordResponse => ({
      version: 5,
      snapshot: {
        courseId: targetCourseId,
        version: 5,
        coveredSourceVersions: { "src-def": 2, "src-thm": 3 },
        nodes: [
          {
            id: "00000000-0000-4000-8000-000000000201",
            courseId: targetCourseId,
            label: "Inner Product",
            kind: "concept",
            evidenceChunkIds: [defChunk.id],
            status: "supported",
          },
          {
            id: "00000000-0000-4000-8000-000000000202",
            courseId: targetCourseId,
            label: "Cauchy-Schwarz",
            kind: "concept",
            evidenceChunkIds: [thmChunk.id],
            status: "supported",
          },
        ],
        edges: [
          {
            from: "00000000-0000-4000-8000-000000000201",
            to: "00000000-0000-4000-8000-000000000202",
            kind: "prerequisite",
            evidenceChunkIds: [],
            status: "supported",
          },
        ],
      },
      sourceVersions: { "src-def": 2, "src-thm": 3 },
      sync: {
        status: "up_to_date",
        activeJobId: null,
        lastBuiltVersion: 5,
        coveredSourceVersions: { "src-def": 2, "src-thm": 3 },
        eligibleSourceVersions: { "src-def": 2, "src-thm": 3 },
        parsingSourceCount: 0,
      },
    });

    it("recalls unseeded prerequisite definitions ahead of seeded theorems in both hybrid and lexicalOnly modes while quarantining sealed/hint blocks", async () => {
      const courseChunks = [thmChunk, defChunk, sealedChunk, hintChunk];
      mocks.readMaterialPurposePin.mockResolvedValue({ courseId, materialUse: "teaching", sources: [] });
      mocks.authorizeChunks.mockImplementation(async (_scope, rows) => ({ chunks: rows, privacyEpoch: 9 }));
      mocks.search.mockResolvedValue([{ chunk: thmChunk, segmentIndex: 0 }, { chunk: sealedChunk, segmentIndex: 0 }]);
      mocks.getWithSync.mockResolvedValue(upToDateRecord());

      const hybrid = await createOpeningMaterialRetriever(sql, budget, config)(scope, {
        courseContext: { courseId, materialUse: "teaching" },
        chunks: courseChunks,
        sourceIds: ["src-def", "src-thm"],
        query: "Cauchy-Schwarz inequality",
        maxCharacters: 4000,
        operationId: "ped-hybrid",
      });
      expect(hybrid.mode).toBe("hybrid");
      expect(mocks.getWithSync).toHaveBeenCalledExactlyOnceWith(scope, courseId);
      expect(hybrid.chunks.map(c => c.id)).toEqual([defChunk.id, thmChunk.id]);

      mocks.embed.mockClear();
      mocks.hasIndex.mockClear();
      const lexicalOnlyResult = await createOpeningMaterialRetriever(sql, budget, config)(scope, {
        courseContext: { courseId, materialUse: "practice" },
        chunks: courseChunks,
        sourceIds: ["src-def", "src-thm"],
        query: "Cauchy-Schwarz inequality",
        maxCharacters: 4000,
        operationId: "ped-lexical-only",
        lexicalOnly: true,
      });
      expect(lexicalOnlyResult.mode).toBe("lexical");
      expect(mocks.hasIndex).not.toHaveBeenCalled();
      expect(mocks.embed).not.toHaveBeenCalled();
      expect(lexicalOnlyResult.chunks.map(c => c.id)).toEqual([defChunk.id, thmChunk.id]);
    });

    it("discards non-supported items, mixed authorized+unauthorized node/edge evidence, stale coveredSourceVersions, and solves edges", async () => {
      const courseChunks = [thmChunk, defChunk];
      mocks.readMaterialPurposePin.mockResolvedValue({ courseId, materialUse: "teaching", sources: [] });
      mocks.authorizeChunks.mockImplementation(async (_scope, rows) => ({ chunks: rows, privacyEpoch: 4 }));
      mocks.search.mockResolvedValue([]);

      const record = upToDateRecord();
      mocks.getWithSync.mockResolvedValue({
        ...record,
        snapshot: {
          ...record.snapshot,
          nodes: [
            // Mixed [authorized, unselected/deleted] evidence -> whole node discarded!
            {
              id: "00000000-0000-4000-8000-000000000201",
              courseId,
              label: "Mixed Node",
              kind: "concept",
              evidenceChunkIds: [defChunk.id, "00000000-0000-4000-8000-000000000999"],
              status: "supported",
            },
            // Needs-check status -> discarded!
            {
              id: "00000000-0000-4000-8000-000000000203",
              courseId,
              label: "Unconfirmed",
              kind: "concept",
              evidenceChunkIds: [defChunk.id],
              status: "needs_check",
            },
            record.snapshot.nodes[1]!,
          ],
          edges: [
            ...record.snapshot.edges,
            {
              from: "00000000-0000-4000-8000-000000000202",
              to: "00000000-0000-4000-8000-000000000201",
              kind: "solves" as "prerequisite",
              evidenceChunkIds: [],
              status: "supported",
            },
          ],
        },
      });

      const mixedNodeResult = await createOpeningMaterialRetriever(sql, budget, null)(scope, {
        courseContext: { courseId, materialUse: "teaching" },
        chunks: courseChunks,
        sourceIds: ["src-def", "src-thm"],
        query: "Cauchy-Schwarz inequality",
        maxCharacters: 4000,
        operationId: "mixed-node",
      });
      // Prerequisite node was discarded because of mixed evidence, so unseeded defChunk is NOT promoted.
      expect(mixedNodeResult.chunks.map(c => c.id)).toEqual([thmChunk.id]);

      // Mixed edge evidenceChunkIds -> whole edge discarded!
      const recordMixedEdge = upToDateRecord();
      recordMixedEdge.snapshot.edges = [
        {
          from: "00000000-0000-4000-8000-000000000201",
          to: "00000000-0000-4000-8000-000000000202",
          kind: "prerequisite",
          evidenceChunkIds: [thmChunk.id, "00000000-0000-4000-8000-000000000888"],
          status: "supported",
        },
      ];
      mocks.getWithSync.mockResolvedValue(recordMixedEdge);
      const mixedEdgeResult = await createOpeningMaterialRetriever(sql, budget, null)(scope, {
        courseContext: { courseId, materialUse: "teaching" },
        chunks: courseChunks,
        sourceIds: ["src-def", "src-thm"],
        query: "Cauchy-Schwarz inequality",
        maxCharacters: 4000,
        operationId: "mixed-edge",
      });
      expect(mixedEdgeResult.chunks.map(c => c.id)).toEqual([thmChunk.id]);

      // Stale coveredSourceVersions on src-def (v1 in graph vs v2 in after.chunks) -> discarded!
      const staleCoverage = upToDateRecord();
      staleCoverage.snapshot.coveredSourceVersions = { "src-def": 1, "src-thm": 3 };
      mocks.getWithSync.mockResolvedValue(staleCoverage);
      const staleResult = await createOpeningMaterialRetriever(sql, budget, null)(scope, {
        courseContext: { courseId, materialUse: "teaching" },
        chunks: courseChunks,
        sourceIds: ["src-def", "src-thm"],
        query: "Cauchy-Schwarz inequality",
        maxCharacters: 4000,
        operationId: "stale-coverage",
      });
      expect(staleResult.chunks.map(c => c.id)).toEqual([thmChunk.id]);

      // Foreign courseId on snapshot or node -> discarded!
      const foreignCourseRecord = upToDateRecord("00000000-0000-4000-8000-000000000999");
      mocks.getWithSync.mockResolvedValue(foreignCourseRecord);
      const foreignResult = await createOpeningMaterialRetriever(sql, budget, null)(scope, {
        courseContext: { courseId, materialUse: "teaching" },
        chunks: courseChunks,
        sourceIds: ["src-def", "src-thm"],
        query: "Cauchy-Schwarz inequality",
        maxCharacters: 4000,
        operationId: "foreign-course",
      });
      expect(foreignResult.chunks.map(c => c.id)).toEqual([thmChunk.id]);
    });

    it.each(["empty", "pending", "needs_rebuild", "stale", "building", "failed"] as const)(
      "falls back to exact standard ranking when sync status is %s or courseId is standalone null",
      async status => {
        const courseChunks = [thmChunk, defChunk];
        mocks.readMaterialPurposePin.mockResolvedValue({ courseId, materialUse: "teaching", sources: [] });
        mocks.authorizeChunks.mockImplementation(async (_scope, rows) => ({ chunks: rows, privacyEpoch: 2 }));
        mocks.search.mockResolvedValue([]);
        const record = upToDateRecord();
        mocks.getWithSync.mockResolvedValue({
          ...record,
          sync: { ...record.sync!, status: status as CourseKnowledgeRecordResponse["sync"] extends { status: infer S } | undefined ? S : never },
        });

        const nonUpToDate = await createOpeningMaterialRetriever(sql, budget, null)(scope, {
          courseContext: { courseId, materialUse: "teaching" },
          chunks: courseChunks,
          sourceIds: ["src-def", "src-thm"],
          query: "Cauchy-Schwarz inequality",
          maxCharacters: 4000,
          operationId: `sync-${status}`,
        });
        expect(nonUpToDate.chunks.map(c => c.id)).toEqual([thmChunk.id]);
      },
    );

    it("skips knowledge lookup for standalone null courseId, tolerates VALIDATION snapshot errors, and propagates abort / NOT_FOUND / CONFLICT fail-closed", async () => {
      mocks.readMaterialPurposePin.mockResolvedValue({ courseId: null, materialUse: "citation", sources: [] });
      mocks.authorizeChunks.mockImplementation(async (_scope, rows) => ({ chunks: rows, privacyEpoch: 1 }));
      const standalone = await createOpeningMaterialRetriever(sql, budget, null)(scope, {
        ...input,
        courseContext: { courseId: null, materialUse: "citation" },
        query: "零空间",
      });
      expect(standalone.chunks.map(c => c.id)).toEqual(["semantic"]);
      expect(mocks.getWithSync).not.toHaveBeenCalled();

      // Malformed snapshot VALIDATION falls back cleanly without breaking retrieval
      mocks.readMaterialPurposePin.mockResolvedValue({ courseId: "owned-course", materialUse: "teaching", sources: [] });
      mocks.getWithSync.mockRejectedValueOnce(new OpeningKnowledgeError("VALIDATION", "malformed snapshot"));
      const recovered = await createOpeningMaterialRetriever(sql, budget, null)(scope, {
        ...input,
        query: "零空间",
      });
      expect(recovered.chunks.map(c => c.id)).toEqual(["semantic"]);

      // Course ownership NOT_FOUND and CONFLICT propagate fail-closed
      mocks.getWithSync.mockRejectedValueOnce(new OpeningKnowledgeError("NOT_FOUND", "course archived"));
      await expect(createOpeningMaterialRetriever(sql, budget, null)(scope, input))
        .rejects.toMatchObject({ code: "NOT_FOUND" });

      mocks.getWithSync.mockRejectedValueOnce(new OpeningKnowledgeError("CONFLICT", "course state conflict"));
      await expect(createOpeningMaterialRetriever(sql, budget, null)(scope, input))
        .rejects.toMatchObject({ code: "CONFLICT" });

      // Abort signal during getWithSync propagates fail-closed
      const controller = new AbortController();
      mocks.getWithSync.mockImplementationOnce(async () => {
        controller.abort();
        return upToDateRecord("owned-course");
      });
      await expect(createOpeningMaterialRetriever(sql, budget, null)(scope, { ...input, signal: controller.signal }))
        .rejects.toThrow();
    });
  });
});
