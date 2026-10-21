import { describe, expect, it, vi } from "vitest";
import { createOpeningEmbeddingProvider, runBudgetedEmbedding, type EmbeddingModel } from "./embedding";

const config: EmbeddingModel = { baseUrl: "https://model.example/v1", apiKey: "test-secret", modelName: "embed-model",
  modelKey: "model-identity", dimensions: 2, inputCentsPerMillion: 10, billing: "metered", dailyRequestCap: null };
const response = (usage: unknown = { prompt_tokens: 12 }) => new Response(JSON.stringify({
  data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage,
}), { headers: { "x-request-id": "provider-receipt" } });
function budget() {
  return { reserve: vi.fn().mockResolvedValue({ id: "reservation" }), claimExecution: vi.fn().mockResolvedValue(true),
    settle: vi.fn().mockResolvedValue(undefined), release: vi.fn().mockResolvedValue(undefined),
    markUnknown: vi.fn().mockResolvedValue(undefined) };
}

describe("embedding provider and ledger", () => {
  it("sends text to the real embedding endpoint and reorders indexed vectors without text wrapping", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response());
    const result = await createOpeningEmbeddingProvider(config, { fetchImpl }).embed(["行空间", "列空间"]);
    expect(result).toEqual({ vectors: [[1, 0], [0, 1]], inputTokens: 12, requestId: "provider-receipt" });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://model.example/v1/embeddings");
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toEqual({ model: "embed-model", input: ["行空间", "列空间"], encoding_format: "float", dimensions: 2 });
  });

  it("supports a fixed-dimension provider and rejects invalid input before sending", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response());
    const provider = createOpeningEmbeddingProvider({ ...config, requestDimensions: false }, { fetchImpl });
    await provider.embed(["a", "b"]);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).not.toHaveProperty("dimensions");
    for (const invalid of [[], [" "], ["中".repeat(3000)], Array(33).fill("a")]) await expect(provider.embed(invalid)).rejects.toMatchObject({ requestSent: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    [{ index: 0, embedding: [1, 0] }],
    [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }],
    [{ index: 0, embedding: [1] }, { index: 1, embedding: [0, 1] }],
    [{ index: 0, embedding: [0, 0] }, { index: 1, embedding: [0, 1] }],
    [{ index: 0, embedding: ["1", 0] }, { index: 1, embedding: [0, 1] }],
  ])("rejects unusable response vectors and keeps the sent request unknown", async (...data) => {
    const ledger = budget(), fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data })));
    await expect(runBudgetedEmbedding({ config, inputs: ["a", "b"], budget: ledger, operationId: "index-1", fetchImpl }))
      .rejects.toMatchObject({ code: "PROVIDER_RESPONSE", requestSent: true });
    expect(ledger.markUnknown).toHaveBeenCalledWith("reservation");
    expect(ledger.release).not.toHaveBeenCalled();
  });

  it("persists vectors before settling and refuses to resend an already settled operation", async () => {
    const ledger = budget(), order: string[] = [], fetchImpl = vi.fn().mockResolvedValue(response());
    ledger.settle.mockImplementation(async () => { order.push("settle"); });
    const persistResult = vi.fn(async (result, receipt) => {
      expect(result.vectors).toEqual([[1, 0], [0, 1]]);
      expect(receipt).toEqual({ reservationId: "reservation", settledCents: 1 }); order.push("persist");
    });
    const options = { config, inputs: ["a", "b"], budget: ledger, operationId: "index-1", fetchImpl, persistResult,
      parentBudget: { id: "study-turn:1", maxProviderCalls: 3 } };
    await runBudgetedEmbedding(options);
    expect(order).toEqual(["persist", "settle"]);
    expect(ledger.reserve).toHaveBeenCalledWith(expect.objectContaining({ purpose: "material-embedding", requestId: "index-1", amountCents: 1,
      parentBudget: { id: "study-turn:1", maxProviderCalls: 3 } }));
    ledger.reserve.mockResolvedValue({ id: "reservation", state: "settled" });
    await expect(runBudgetedEmbedding(options)).rejects.toMatchObject({ code: "BUDGET_REPLAY_COMPLETED" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps missing usage unknown while storing the usable result", async () => {
    const ledger = budget(), persistResult = vi.fn(), fetchImpl = vi.fn().mockResolvedValue(response(null));
    await runBudgetedEmbedding({ config, inputs: ["a", "b"], budget: ledger, operationId: "index-1", persistResult, fetchImpl });
    expect(persistResult).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: null }), { reservationId: "reservation", settledCents: null });
    expect(ledger.markUnknown).toHaveBeenCalledWith("reservation"); expect(ledger.settle).not.toHaveBeenCalled();
  });

  it("checks current source permission after reserving and before transmitting", async () => {
    const ledger = budget(), fetchImpl = vi.fn();
    await expect(runBudgetedEmbedding({ config, inputs: ["a"], budget: ledger, operationId: "index-1", fetchImpl,
      beforeSend: async () => { throw new Error("source excluded"); } })).rejects.toThrow("source excluded");
    expect(fetchImpl).not.toHaveBeenCalled(); expect(ledger.release).toHaveBeenCalledWith("index-1", "not_sent");
  });

  it("does not invent a one-cent charge when a paid provider reports zero input usage", async () => {
    const ledger = budget(), fetchImpl = vi.fn().mockResolvedValue(response({ prompt_tokens: 0 }));
    await expect(runBudgetedEmbedding({ config, inputs: ["a", "b"], budget: ledger, operationId: "index-1", fetchImpl }))
      .rejects.toMatchObject({ code: "BUDGET_INVALID_ACTUAL" });
    expect(ledger.markUnknown).toHaveBeenCalledWith("reservation"); expect(ledger.settle).not.toHaveBeenCalled();
  });

  it("accounts for a bounded free request and releases provider refusals", async () => {
    const ledger = budget(), fetchImpl = vi.fn().mockResolvedValue(response());
    await runBudgetedEmbedding({ config: { ...config, billing: "free_tier", inputCentsPerMillion: 0, dailyRequestCap: 5 },
      inputs: ["a", "b"], budget: ledger, operationId: "free-1", fetchImpl });
    expect(ledger.reserve).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 0, requestCapPerDay: 5 }));
    expect(ledger.settle).toHaveBeenCalledWith("reservation", 0);
    fetchImpl.mockResolvedValue(new Response("", { status: 429 }));
    await expect(runBudgetedEmbedding({ config, inputs: ["a"], budget: ledger, operationId: "index-2", fetchImpl }))
      .rejects.toMatchObject({ code: "PROVIDER_RATE_LIMIT" });
    expect(ledger.release).toHaveBeenCalledWith("index-2", "not_sent");
  });

  it("aborts a hung provider at the deadline, including response reads", async () => {
    const fetchImpl = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    await expect(createOpeningEmbeddingProvider(config, { fetchImpl, timeoutMs: 5 }).embed(["a"]))
      .rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", requestSent: true });
  });

  it("applies the interactive deadline through the ledger and keeps a sent timeout unknown", async () => {
    const ledger = budget();
    const fetchImpl = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    await expect(runBudgetedEmbedding({ config, inputs: ["a"], budget: ledger, operationId: "query-1", fetchImpl, timeoutMs: 5 }))
      .rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", requestSent: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(ledger.markUnknown).toHaveBeenCalledWith("reservation");
    expect(ledger.release).not.toHaveBeenCalled();
  });
});
