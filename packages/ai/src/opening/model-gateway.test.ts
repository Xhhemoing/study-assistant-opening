import { describe, expect, it, vi } from "vitest";
import type { ProviderInput, ProviderOutput } from "@aistudy/contracts";
import type { BudgetedRepository } from "./budgeted-call";
import { createModelGateway, isNotSentFailure, reservationTerms, type ResolvedTaskModel } from "./model-gateway";
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

describe("model gateway fallback and free tier", () => {
  const fallbackModel = (complete = vi.fn(async () => output)): ResolvedTaskModel => ({
    ...model(complete),
    modelSnapshot: { id: "m2", providerId: "p2", modelName: "backup", inputCentsPerMillion: 0, outputCentsPerMillion: 0 },
    inputCentsPerMillion: 0,
    outputCentsPerMillion: 0,
    billing: "free_tier",
    dailyRequestCap: 200,
  });

  it("uses the explicit fallback under its own ledger key when the primary was rate limited (not sent)", async () => {
    const { OpeningProviderError } = await import("./provider");
    const primaryComplete = vi.fn(async () => { throw new OpeningProviderError("PROVIDER_RATE_LIMIT", "429", true); });
    const backupComplete = vi.fn(async () => output);
    const { calls, repo } = budget();
    const used: boolean[] = [];
    const gateway = createModelGateway({
      resolve: async () => model(primaryComplete),
      resolveFallback: async () => fallbackModel(backupComplete),
    });
    await gateway.call(scope, "teaching.compile", { budget: repo, input, operationId: "op", onModel: (_m, info) => used.push(info.fallback) });
    expect(backupComplete).toHaveBeenCalledTimes(1);
    expect(used).toEqual([false, true]);
    expect(calls.reserve.map((entry) => entry.requestId)).toEqual(["op", "op:fallback"]);
    // Free tier reserves zero under its request cap and settles at zero.
    expect(calls.reserve[1]).toMatchObject({ amountCents: 0, requestCapPerDay: 200, modelSnapshot: expect.objectContaining({ id: "m2" }) });
    expect(calls.settle).toEqual([0]);
  });

  it("never falls back after an unknown outcome (timeout) to avoid a double send", async () => {
    const { OpeningProviderError } = await import("./provider");
    const backupComplete = vi.fn(async () => output);
    const { repo } = budget();
    const gateway = createModelGateway({
      resolve: async () => model(vi.fn(async () => { throw new OpeningProviderError("PROVIDER_TIMEOUT", "timeout", true); })),
      resolveFallback: async () => fallbackModel(backupComplete),
    });
    await expect(gateway.call(scope, "teaching.compile", { budget: repo, input, operationId: "op" })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(backupComplete).not.toHaveBeenCalled();
  });

  it("falls back when the primary route is unusable or the ledger refused the reservation", async () => {
    const backupComplete = vi.fn(async () => output);
    const { repo } = budget();
    await createModelGateway({
      resolve: async () => { throw new OpeningModelRoutingError("所选模型暂不可用"); },
      resolveFallback: async () => fallbackModel(backupComplete),
    }).call(scope, "teaching.compile", { budget: repo, input, operationId: "op" });
    expect(backupComplete).toHaveBeenCalledTimes(1);
    expect(isNotSentFailure(Object.assign(new Error("cap"), { code: "REQUEST_CAP_EXCEEDED" }))).toBe(true);
    expect(isNotSentFailure(Object.assign(new Error("cap"), { code: "BUDGET_EXCEEDED" }))).toBe(true);
    expect(isNotSentFailure(new Error("other"))).toBe(false);
  });

  it("without a fallback the primary error stands", async () => {
    const { repo } = budget();
    await expect(createModelGateway({ resolve: async () => { throw new OpeningModelRoutingError("x"); } })
      .call(scope, "teaching.compile", { budget: repo, input, operationId: "op" })).rejects.toBeInstanceOf(OpeningModelRoutingError);
  });

  it("reservationTerms: paid models reserve at least the floor, free tier requires a cap", () => {
    expect(reservationTerms(model(), input, 300).reservedCents).toBe(300);
    expect(reservationTerms(fallbackModel(), input, 300)).toMatchObject({ reservedCents: 0, requestCapPerDay: 200 });
    expect(() => reservationTerms({ ...fallbackModel(), dailyRequestCap: null }, input)).toThrow(OpeningModelRoutingError);
  });
});
