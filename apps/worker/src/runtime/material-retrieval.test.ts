import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceChunk } from "@aistudy/contracts";
import type { OpeningBudgetRepository } from "@aistudy/database";

const mocks = vi.hoisted(() => ({ authorizeChunks: vi.fn(), hasIndex: vi.fn(), search: vi.fn(), embed: vi.fn() }));
vi.mock("@aistudy/database", async original => ({ ...(await original<typeof import("@aistudy/database")>()),
  createOpeningSourceEmbeddingsRepository: () => mocks }));
vi.mock("@aistudy/ai", async original => ({ ...(await original<typeof import("@aistudy/ai")>()), runBudgetedEmbedding: mocks.embed }));
import { createOpeningMaterialRetriever } from "./material-retrieval";
const config = { modelKey: "test-model:3", baseUrl: "https://models.example.test/v1", modelName: "embedding", apiKey: "test",
  dimensions: 3, inputCentsPerMillion: 1, billing: "metered" as const, dailyRequestCap: null, requestDimensions: true };
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const chunks: SourceChunk[] = [
  { id: "literal", sourceId: "source1", text: "unrelated pages", page: 1, sourceVersion: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null },
  { id: "semantic", sourceId: "source9", text: "矩阵的零空间", page: 2, sourceVersion: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null },
];
const input = { chunks, sourceIds: chunks.map(chunk => chunk.sourceId), query: "What is a kernel?", maxCharacters: 1000, operationId: "saved-job" };
const sql = {} as Parameters<typeof createOpeningMaterialRetriever>[0], budget = {} as OpeningBudgetRepository;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorizeChunks.mockImplementation(async (_scope, rows) => ({ chunks: rows, privacyEpoch: 1 }));
  mocks.hasIndex.mockResolvedValue(true);
  mocks.search.mockResolvedValue([{ chunk: chunks[1], segmentIndex: 0 }]);
  mocks.embed.mockImplementation(async options => { await options.beforeSend?.(); return { vectors: [[1, 0, 0]], inputTokens: 10, requestId: "provider" }; });
});

describe("shared material retriever", () => {
  it("keeps dense ranking and scopes the real embedding request and search to admitted sources", async () => {
    const parentBudget = { id: "study-turn:user-turn" };
    const result = await createOpeningMaterialRetriever(sql, budget, config)(scope, { ...input, parentBudget });
    expect(result).toMatchObject({ mode: "hybrid", chunks: [{ id: "semantic" }] });
    expect(mocks.embed).toHaveBeenCalledWith(expect.objectContaining({ inputs: [input.query], operationId: "material-query:saved-job", parentBudget, timeoutMs: 2_000 }));
    expect(mocks.search).toHaveBeenCalledWith(scope, expect.objectContaining({ sourceIds: input.sourceIds, modelKey: config.modelKey, dimensions: 3 }));
  });
  it.each(["configuration", "index", "quota", "timeout"])("falls back to lexical material when %s is unavailable", async reason => {
    if (reason === "index") mocks.hasIndex.mockResolvedValue(false);
    if (reason === "quota") mocks.embed.mockRejectedValue(new Error("budget limit"));
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
    expect(result).toEqual({ chunks: [], mode: "lexical" });
    expect(mocks.search).not.toHaveBeenCalled();
  });
});
