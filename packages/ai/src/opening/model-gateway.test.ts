import { describe, expect, it, vi } from "vitest";
import type { ProviderInput, ProviderOutput } from "@aistudy/contracts";
import type { BudgetedRepository } from "./budgeted-call";
import { createModelGateway, type ResolvedTaskModel } from "./model-gateway";
import { OpeningModelRoutingError } from "./model-routing";

const scope = { workspaceId: "w", ownerUserId: "u" };
const output: ProviderOutput = { text: "{}", citedChunkIds: [], requestId: null, candidates: [], inputTokens: 1_000_000, outputTokens: 1_000_000 };
const input: ProviderInput = {
  instruction: "extract", text: "t", history: [], chunks: [], mode: "explain",
  maxOutputTokens: 100, mediaCapability: "text_only", imageParts: [],
};

function budget() {
  const calls = { reserve: [] as Parameters<BudgetedRepository["reserve"]>[0][], settle: [] as number[] };
  const repo: BudgetedRepository = {
    reserve: async (entry) => { calls.reserve.push(entry); return { id: "res-1" }; },
    release: async () => undefined,
    claimExecution: async () => true,
    settle: async (_id, cents) => { calls.settle.push(cents); },
    markUnknown: async () => undefined,
  };
  return { calls, repo };
}

function model(complete = vi.fn(async () => output)): ResolvedTaskModel {
  return {
    provider: { complete },
    modelSnapshot: { id: "m1", providerId: "p1", modelName: "real-model", inputCentsPerMillion: 3, outputCentsPerMillion: 5 },
    inputCentsPerMillion: 3,
    outputCentsPerMillion: 5,
    supportsVision: false,
  };
}

describe("model gateway", () => {
  it("resolves the task's model once and records its snapshot, purpose and priced settle", async () => {
    const resolved = model();
    const resolve = vi.fn(async () => resolved);
    const { calls, repo } = budget();
    const result = await createModelGateway({ resolve }).call(scope, "knowledge.extract", { budget: repo, input, operationId: "build-course-knowledge:job-1", minReservedCents: 50 });
    expect(result).toBe(output);
    expect(resolve).toHaveBeenCalledWith(scope, "knowledge.extract");
    expect(calls.reserve).toHaveLength(1);
    expect(calls.reserve[0]).toMatchObject({ purpose: "build-course-knowledge", requestId: "build-course-knowledge:job-1", modelSnapshot: resolved.modelSnapshot });
    expect(calls.reserve[0]!.amountCents).toBe(50);
    expect(calls.settle).toEqual([8]);
  });

  it("budgetedProvider adapts handler-style complete() to the same budgeted path", async () => {
    const complete = vi.fn(async () => output);
    const { calls, repo } = budget();
    const provider = createModelGateway({ resolve: async () => model(complete) })
      .budgetedProvider(scope, "tutor.explain", { budget: repo, operationId: "op-1", minReservedCents: 400 });
    await provider.complete(input);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(calls.reserve[0]).toMatchObject({ purpose: "tutor", amountCents: 400 });
  });

  it("fails before reserving when the route cannot be resolved", async () => {
    const { calls, repo } = budget();
    const gateway = createModelGateway({ resolve: async () => { throw new OpeningModelRoutingError("所选模型已移除"); } });
    await expect(gateway.call(scope, "knowledge.extract", { budget: repo, input, operationId: "op-2" })).rejects.toBeInstanceOf(OpeningModelRoutingError);
    expect(calls.reserve).toHaveLength(0);
  });
});
