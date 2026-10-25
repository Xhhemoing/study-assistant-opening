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

  it("forwards awaited text deltas through both gateway adapters before persisting and settling", async () => {
    const events: string[] = [];
    const resolved = model();
    resolved.provider.complete = async (_input, _signal, onTextDelta) => {
      await onTextDelta?.("first"); await onTextDelta?.(" second"); return output;
    };
    const { repo } = budget();
    const gateway = createModelGateway({ resolve: async () => resolved });
    const settings = { budget: repo, operationId: "stream", persistResult: async () => { events.push("persist"); } };
    const onTextDelta = async (value: string) => { events.push(value); };
    await gateway.call(scope, "tutor.explain", { ...settings, input: { ...input, outputFormat: "markdown" }, onTextDelta });
    await gateway.budgetedProvider(scope, "tutor.explain", settings).complete(input, undefined, onTextDelta);
    expect(events).toEqual(["first", " second", "persist", "first", " second", "persist"]);
  });

  it("does not use a fallback after partial text and an unknown provider outcome", async () => {
    const { OpeningProviderError } = await import("./provider");
    const resolved = model(), fallback = vi.fn(), onTextDelta = vi.fn();
    resolved.provider.complete = async (_input, _signal, deliver) => { await deliver?.("partial"); throw new OpeningProviderError("PROVIDER_TIMEOUT", "idle", true, true); };
    const { repo } = budget();
    const unknown = vi.fn();
    await expect(createModelGateway({ resolve: async () => resolved, resolveFallback: fallback }).call(scope, "tutor.explain", {
      budget: { ...repo, markUnknown: unknown }, input, operationId: "partial", onTextDelta,
    })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(onTextDelta).toHaveBeenCalledExactlyOnceWith("partial"); expect(unknown).toHaveBeenCalledOnce(); expect(fallback).not.toHaveBeenCalled();
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

  it("rejects overflowing estimates before reserve/send and uses only the explicit fallback", async () => {
    const primaryComplete = vi.fn(async () => output);
    const backupComplete = vi.fn(async () => output);
    const primary = { ...model(primaryComplete), inputCentsPerMillion: 1e308, outputCentsPerMillion: 1e308 };
    const { calls, repo } = budget();
    await expect(createModelGateway({ resolve: async () => primary })
      .call(scope, "practice.grade-text", { budget: repo, input, operationId: "overflow-none" }))
      .rejects.toBeInstanceOf(OpeningModelRoutingError);
    expect(calls.reserve).toHaveLength(0);
    expect(primaryComplete).not.toHaveBeenCalled();
    await createModelGateway({ resolve: async () => primary, resolveFallback: async () => fallbackModel(backupComplete) })
      .call(scope, "practice.grade-text", { budget: repo, input, operationId: "overflow-safe" });
    expect(primaryComplete).not.toHaveBeenCalled();
    expect(backupComplete).toHaveBeenCalledTimes(1);
    expect(calls.reserve).toHaveLength(1);
    expect(calls.reserve[0]).toMatchObject({ requestId: "overflow-safe:fallback", amountCents: 0 });
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

describe("parent interaction through gateway fallback", () => {
  it("uses one shared parent across separate rounds and the fallback key", async () => {
    const { OpeningProviderError } = await import("./provider");
    const { calls, repo } = budget();
    const parentBudget = { id: "study-turn:user-1", budgetCents: 500 };
    const gateway = createModelGateway({
      resolve: async () => model(vi.fn(async () => { throw new OpeningProviderError("PROVIDER_AUTH", "bad key"); })),
      resolveFallback: async () => model(),
    });
    await gateway.call(scope, "tutor.explain", { budget: repo, input, operationId: "round:1", parentBudget });
    await gateway.call(scope, "tutor.explain", { budget: repo, input, operationId: "round:2", parentBudget });
    expect(calls.reserve.map(r => r.parentBudget)).toEqual([parentBudget, parentBudget, parentBudget, parentBudget]);
    expect(calls.reserve.map(r => r.requestId)).toEqual(["round:1", "round:1:fallback", "round:2", "round:2:fallback"]);
  });
});

describe("provider-free reservation estimation", () => {
  it("prices the real serialized prompt, output bound, floor and media without constructing a provider", () => {
    const selected: Omit<ResolvedTaskModel, "provider"> = {
      modelSnapshot: { id: "estimate", providerId: "p", modelName: "m", inputCentsPerMillion: 1_000_000, outputCentsPerMillion: 1_000_000 },
      inputCentsPerMillion: 1_000_000, outputCentsPerMillion: 1_000_000,
    };
    const short = reservationTerms(selected, input);
    const long = reservationTerms(selected, { ...input, instruction: "reference".repeat(1000), text: "answer".repeat(1000) });
    expect(long.reservedCents).toBeGreaterThan(short.reservedCents);
    expect(reservationTerms(selected, { ...input, maxOutputTokens: input.maxOutputTokens + 100 }).reservedCents).toBe(short.reservedCents + 100);
    expect(reservationTerms(selected, input, 100_000).reservedCents).toBe(100_000);
    const media = { ...selected, mediaInputTokenUpperBound: 8000, mediaMaxInputBytes: 10000, mediaInputCentsPerMillion: 1_000_000 };
    expect(reservationTerms(media, { ...input, imageParts: [{ mediaType: "image/png", data: "data:image/png;base64,aGVsbG8=" }] }).reservedCents).toBeGreaterThanOrEqual(short.reservedCents + 8000);
    expect(reservationTerms({ ...selected, billing: "free_tier", dailyRequestCap: 2 }, input, 100_000)).toMatchObject({ reservedCents: 0, requestCapPerDay: 2 });
  });
});

describe("priced transport input bound", () => {
  it("reserves the full transmitted prompt including style and history, and enforces the output cap on wire", async () => {
    const { createOpeningProvider } = await import("./provider");
    const { calls, repo } = budget();
    let wireBody = "";
    const provider = createOpeningProvider({ baseUrl: "https://model.example", apiKey: "test", model: "m", answerStyle: true,
      fetchImpl: (async (_url, init) => {
        wireBody = String(init?.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"ok","citedChunkIds":[],"candidates":[]}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
      }) as typeof fetch,
    });
    const gateway = createModelGateway({ resolve: async () => ({ ...model(), provider, inputCentsPerMillion: 1_000_000, outputCentsPerMillion: 1_000_000 }) });
    await gateway.call(scope, "tutor.explain", { budget: repo, operationId: "wire-bound", input: { ...input,
      instruction: "说明".repeat(200), history: [{ role: "assistant", text: "步骤".repeat(500) }], maxOutputTokens: 123,
    } });
    expect(calls.reserve[0]!.amountCents).toBeGreaterThanOrEqual(new TextEncoder().encode(wireBody).length + 123);
    expect(JSON.parse(wireBody).max_tokens).toBe(123);
    expect(JSON.parse(wireBody).messages[0].content).toContain("写作规则");
  });
});

it("prices verified media context limits independently from encoded image byte count", () => {
  const snapshot = { ...model().modelSnapshot, mediaInputTokenUpperBound: 8000, mediaMaxInputBytes: 10000, mediaInputCentsPerMillion: 1_000_000 };
  const mediaModel = { ...model(), modelSnapshot: snapshot, ...snapshot };
  const mediaInput = { ...input, mediaCapability: "text_plus_page_images" as const,
    imageParts: [{ mediaType: "image/png" as const, data: "data:image/png;base64,aGVsbG8=" }] };
  const first = reservationTerms(mediaModel, mediaInput);
  const largerEncoded = reservationTerms(mediaModel, { ...mediaInput, imageParts: [{ ...mediaInput.imageParts[0]!, data: `data:image/png;base64,${"A".repeat(8000)}` }] });
  expect(first.reservedCents).toBeGreaterThan(8000);
  expect(largerEncoded.reservedCents).toBe(first.reservedCents);
  expect(first.actualCents({ ...output, inputTokens: 123, outputTokens: 0 })).toBe(123);
});

it.each(["missing", "too_small"])("falls back from %s media bounds before sending under the original parent budget", async failure => {
  const { calls, repo } = budget();
  const primary = model(), fallback = model();
  if (failure === "too_small") primary.modelSnapshot = { ...primary.modelSnapshot, mediaInputTokenUpperBound: 8000, mediaMaxInputBytes: 1, mediaInputCentsPerMillion: 2 };
  fallback.modelSnapshot = { ...fallback.modelSnapshot, id: "configured-media", mediaInputTokenUpperBound: 8000,
    mediaMaxInputBytes: 1024, mediaInputCentsPerMillion: 2 };
  const parentBudget = { id: "study-turn:media-fallback", budgetCents: 100 };
  const gateway = createModelGateway({ resolve: async () => primary, resolveFallback: async () => fallback });
  await gateway.call(scope, "tutor.explain", { budget: repo, operationId: "media-op", parentBudget,
    input: { ...input, mediaCapability: "text_plus_page_images", imageParts: [{ data: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" }] },
  });
  expect(primary.provider.complete).not.toHaveBeenCalled();
  expect(fallback.provider.complete).toHaveBeenCalledOnce();
  expect(calls.reserve).toHaveLength(1);
  expect(calls.reserve[0]).toMatchObject({ requestId: "media-op:fallback", parentBudget });
});


it("never lowers known text pricing when a media rate was configured below it", () => {
  const selected = { ...model(), inputCentsPerMillion: 100, outputCentsPerMillion: 1 };
  selected.modelSnapshot = { ...selected.modelSnapshot, inputCentsPerMillion: 100, mediaInputTokenUpperBound: 1_000_000,
    mediaMaxInputBytes: 1024, mediaInputCentsPerMillion: 1 };
  const terms = reservationTerms(selected, { ...input, imageParts: [{ data: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" }] });
  expect(terms.reservedCents).toBeGreaterThanOrEqual(100);
  expect(terms.actualCents({ ...output, inputTokens: 1_000_000, outputTokens: 0 })).toBe(100);
});
