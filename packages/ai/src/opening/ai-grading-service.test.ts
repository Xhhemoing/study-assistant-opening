import { expect, it, vi } from "vitest";
import type { AiGradingMaterialProvenance, LearningObservation, ProviderOutput, Scope } from "@aistudy/contracts";
import { createOpeningAiGradingService, type OpeningAiGradingServiceDeps } from "./ai-grading-service";
import { createModelGateway, type ResolvedTaskModel } from "./model-gateway";

const scope: Scope = { workspaceId: "00000000-0000-4000-8000-000000000001", ownerUserId: "00000000-0000-4000-8000-000000000002" };
const input = { observationId: "00000000-0000-4000-8000-000000000003" };
const base = `ai-grade:${scope.workspaceId}:${input.observationId}`;
const proposal = { outcome: "correct", questionMatch: true, confidence: .95, feedback: "正确",
  criteria: [{ label: "计算", verdict: "correct", feedback: "结果为1。" }] };
const output: ProviderOutput = { text: JSON.stringify(proposal), inputTokens: 10, outputTokens: 10,
  citedChunkIds: [], candidates: [], requestId: null };
const original = { id: input.observationId, answer: "1", outcome: "unverified" } as LearningObservation;
const graded = { ...original, id: "00000000-0000-4000-8000-000000000004", outcome: "correct" } as LearningObservation;
const provenance: AiGradingMaterialProvenance = {
  materialAnswerRefs: [{ sourceId: "00000000-0000-4000-8000-000000000005", sourceVersion: 1, manifestRevision: 2 }],
  materialSourceRefs: [{ sourceId: "00000000-0000-4000-8000-000000000006", sourceVersion: 0, manifestRevision: 3 }],
};
type Repository = OpeningAiGradingServiceDeps["repository"];
type Budget = ReturnType<OpeningAiGradingServiceDeps["budget"]>;

function setup() {
  const complete = vi.fn(async () => output);
  const model: ResolvedTaskModel = { provider: { complete }, inputCentsPerMillion: 20_000, outputCentsPerMillion: 20_000,
    modelSnapshot: { id: "changed", providerId: "fixture", modelName: "changed-model", inputCentsPerMillion: 20_000, outputCentsPerMillion: 20_000 } };
  let saved: LearningObservation | null = null;
  const repository = {
    context: vi.fn(async () => ({ observation: original, stem: "1/2+1/2?", referenceText: "1", misconceptions: [],
      existing: saved, answerRevision: 1, operationId: base, workSource: null, materialProvenance: structuredClone(provenance) })),
    apply: vi.fn<Repository["apply"]>(async () => { saved = graded; return graded; }),
    ledger: vi.fn<Repository["ledger"]>(async () => "unsent"),
    releasedReservation: vi.fn<NonNullable<Repository["releasedReservation"]>>(async () => null),
  };
  const budget = { reserve: vi.fn<Budget["reserve"]>(async () => ({ id: "fresh", state: "reserved" })),
    claimExecution: vi.fn(async () => true), settle: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined), markUnknown: vi.fn(async () => undefined) };
  const gateway = createModelGateway({ resolve: async () => model });
  const service = createOpeningAiGradingService({ repository, gateway, budget: () => budget, images: async () => [] });
  return { repository, budget, complete, service };
}

it.each(["not_sent", "cancelled"] as const)("replays %s before a changed-model reserve and advances the existing deterministic chain", async reason => {
  const f = setup();
  f.repository.releasedReservation.mockImplementation(async (_scope, terms) => terms.requestId === base
    ? { id: "first", state: "released", releaseReason: reason }
    : terms.requestId === `${base}:retry:first` ? { id: "second", state: "released", releaseReason: reason } : null);
  f.budget.reserve.mockImplementation(async terms => {
    if (terms.requestId !== `${base}:retry:second`) throw Object.assign(new Error("old snapshot mismatch"), { code: "CONFLICT" });
    return { id: "fresh", state: "reserved" };
  });
  expect(await f.service.grade(scope, input)).toBe(graded);
  expect(f.repository.releasedReservation.mock.calls.map(([, terms]) => terms.requestId)).toEqual([base, `${base}:retry:first`, `${base}:retry:second`]);
  expect(f.budget.reserve).toHaveBeenCalledTimes(1);
  expect(f.budget.reserve).toHaveBeenCalledWith(expect.objectContaining({ requestId: `${base}:retry:second`, modelSnapshot: expect.objectContaining({ modelName: "changed-model" }) }));
  expect(f.budget.claimExecution).toHaveBeenCalledExactlyOnceWith("fresh");
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(await f.service.grade(scope, input)).toBe(graded);
  expect(f.complete).toHaveBeenCalledTimes(1);
});

it.each(["unknown", "in_flight", "completed", "blocked"] as const)("does not use a released receipt when any family member is %s", async state => {
  const f = setup(); f.repository.ledger.mockResolvedValue(state);
  f.repository.releasedReservation.mockResolvedValue({ id: "first", state: "released", releaseReason: "not_sent" });
  await expect(f.service.grade(scope, input)).rejects.toMatchObject({ code: state === "unknown" || state === "in_flight" ? "GRADING_UNKNOWN_COST" : "CONFLICT" });
  expect(f.repository.releasedReservation).not.toHaveBeenCalled();
  expect(f.budget.reserve).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
});

it("rechecks unknown family state before the gateway reserves a fallback", async () => {
  const f = setup();
  f.repository.releasedReservation.mockImplementation(async () => {
    f.repository.ledger.mockResolvedValue("unknown");
    return { id: "first", state: "released", releaseReason: "not_sent" };
  });
  const fallback: ResolvedTaskModel = { provider: { complete: f.complete }, inputCentsPerMillion: 1, outputCentsPerMillion: 1,
    modelSnapshot: { id: "fallback", providerId: "fixture", modelName: "fallback", inputCentsPerMillion: 1, outputCentsPerMillion: 1 } };
  const gateway = createModelGateway({ resolve: async () => fallback, resolveFallback: async () => fallback });
  const service = createOpeningAiGradingService({ repository: f.repository, gateway, budget: () => f.budget, images: async () => [] });
  await expect(service.grade(scope, input)).rejects.toMatchObject({ code: "GRADING_UNKNOWN_COST" });
  expect(f.repository.releasedReservation).toHaveBeenCalledTimes(1);
  expect(f.budget.reserve).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
});

it("keeps normal reserve conflicts when the key has no confirmed released receipt", async () => {
  const f = setup();
  f.budget.reserve.mockRejectedValue(Object.assign(new Error("snapshot conflict"), { code: "CONFLICT" }));
  await expect(f.service.grade(scope, input)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(f.budget.reserve).toHaveBeenCalledTimes(1); expect(f.complete).not.toHaveBeenCalled();
});

it("passes the originally captured dependency set to publication rather than a later context", async () => {
  const f = setup();
  expect(await f.service.grade(scope, input)).toBe(graded);
  expect(f.repository.apply).toHaveBeenCalledExactlyOnceWith(scope, input, proposal, "changed-model", provenance);
});

it.each(["revision", "new reverse link", "removed reverse link"])("does not send a stale prompt after a %s change", async change => {
  const f = setup(), initial = await f.repository.context();
  const changed = structuredClone(provenance);
  if (change === "revision") changed.materialSourceRefs[0]!.manifestRevision += 1;
  if (change === "new reverse link") changed.materialAnswerRefs.push({ sourceId: "00000000-0000-4000-8000-000000000007", sourceVersion: 1, manifestRevision: 1 });
  if (change === "removed reverse link") changed.materialAnswerRefs = [];
  f.repository.context.mockResolvedValue({ ...initial, materialProvenance: changed }).mockResolvedValueOnce(initial);
  await expect(f.service.grade(scope, input)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.repository.apply).not.toHaveBeenCalled();
});

it.each([false, true])("never replaces captured dependencies after send and honors unknown spend when context rejects=%s", async rejectedContext => {
  const f = setup(), initial = await f.repository.context(), live = structuredClone(initial);
  live.materialProvenance.materialAnswerRefs[0]!.manifestRevision += 1;
  f.complete.mockImplementation(async () => {
    if (rejectedContext) f.repository.context.mockRejectedValue(Object.assign(new Error("reference disputed"), { code: "CONFLICT" }));
    else f.repository.context.mockResolvedValue(live);
    f.repository.ledger.mockResolvedValue("unknown");
    return output;
  });
  f.repository.apply.mockImplementation(async (_scope, _input, _proposal, _model, captured) => {
    expect(captured).toEqual(provenance);
    throw Object.assign(new Error("material changed"), { code: "CONFLICT" });
  });
  await expect(f.service.grade(scope, input)).rejects.toMatchObject({ code: "GRADING_UNKNOWN_COST" });
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.repository.apply).toHaveBeenCalledTimes(1);
});
