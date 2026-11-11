import { expect, it, vi } from "vitest";
import type { ProviderOutput, StudyContextAnchor, StudyExposureReceipt } from "@aistudy/contracts";
import { createEphemeralTutorService, type EphemeralProvider } from "./ephemeral-service";

const id = (n: number) => `13000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) };
const anchor: StudyContextAnchor = { courseId: id(3), attemptId: id(4), purpose: "learning_help" };
const output: ProviderOutput = { text: "synthetic hint", citedChunkIds: [], candidates: [], requestId: "provider", inputTokens: 10, outputTokens: 5 };
const input = { text: "give a hint", sourceIds: [], mode: "hint" as const, history: [], contextAnchor: anchor };
const receipt = { id: id(5), contextAnchor: anchor } as StudyExposureReceipt;
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
function fixture(complete: EphemeralProvider["complete"], override: { assertCurrent?: () => Promise<void>; resolve?: () => Promise<StudyContextAnchor>; epochRead?: () => Promise<number> } = {}) {
  const state = { epoch: 1 };
  const deliver = vi.fn(async () => receipt);
  const budget = { reserve: vi.fn(async () => ({ id: "reservation" })), claimExecution: async () => true,
    settle: vi.fn(async () => {}), release: vi.fn(async () => {}), markUnknown: vi.fn(async () => {}) };
  const service = createEphemeralTutorService({ provider: { complete }, budget, sources: { listOwnedIds: async () => [] },
    chunks: { listForSources: async () => [] }, privacy: { snapshot: async () => ({ epoch: state.epoch, excludedSourceIds: [] }), currentEpoch: override.epochRead ?? (async () => state.epoch) },
    retrieveContext: override.assertCurrent ? async () => ({ chunks: [], mode: "lexical", assertCurrent: override.assertCurrent }) : undefined,
    studyContext: { resolve: override.resolve ?? (async () => anchor) }, exposures: { deliver }, requestKey: () => "batch8",
    config: { maxContextCharacters: 12000, maxOutputTokens: 500, reservedCents: 10, inputCentsPerMillion: 1, outputCentsPerMillion: 1 } });
  return { service, deliver, budget, state };
}
// Provider, budget, callback and exposure are synthetic in-process doubles.
it("withholds the first delta until the exact exposure delivery promise resolves", async () => {
  const started = deferred<void>(), gate = deferred<StudyExposureReceipt>(), emitted = deferred<void>(); const displayed: string[] = [];
  const f = fixture(async (_input, _signal, emit) => { await emit?.("first"); emitted.resolve(); return output; });
  f.deliver.mockImplementationOnce(() => { started.resolve(); return gate.promise; });
  const call = f.service.replyEphemeral(scope, input, undefined, delta => { displayed.push(delta); });
  const settled = call.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  try {
    const arrival = await Promise.race([started.promise.then(() => ({ entered: true as const })), settled.then(result => ({ entered: false as const, result }))]);
    if (!arrival.entered && !arrival.result.ok) throw arrival.result.error;
    expect(arrival.entered).toBe(true);
    const phase = await Promise.race([emitted.promise.then(() => "emitted"), new Promise<"barrier">(resolve => setImmediate(() => resolve("barrier")))]);
    expect(phase).toBe("barrier"); expect(displayed).toEqual([]);
  } finally { gate.resolve(receipt); await settled; }
  expect(displayed).toEqual(["first"]); expect(f.deliver).toHaveBeenCalledOnce();
  expect(await call).toMatchObject({ exposureReceipt: { id: id(5) } });
});
it("propagates a failed first exposure delivery without emitting any delta", async () => {
  const f = fixture(async (_input, _signal, emit) => { await emit?.("must-not-display"); return output; });
  const failure = new Error("synthetic exposure failure"), displayed = vi.fn(); f.deliver.mockRejectedValueOnce(failure);
  await expect(f.service.replyEphemeral(scope, input, undefined, displayed)).rejects.toBe(failure);
  expect(displayed).not.toHaveBeenCalled(); expect(f.deliver).toHaveBeenCalledOnce();
});
it("ignores empty deltas until real output and releases exactly once", async () => {
  const order: string[] = [];
  const f = fixture(async (_input, _signal, emit) => { await emit?.(""); order.push("empty-observed"); await emit?.("real"); return output; });
  f.deliver.mockImplementation(async () => { order.push("delivery"); return receipt; });
  await f.service.replyEphemeral(scope, input, undefined, delta => { order.push(`delta:${delta}`); });
  expect(order).toEqual(["empty-observed", "delivery", "delta:real"]); expect(f.deliver).toHaveBeenCalledOnce();
});
it("records the resolved server anchor and server-selected hint policy rather than client identity", async () => {
  const requested: StudyContextAnchor = { purpose: "learning_help", attemptId: id(6) };
  const canonical: StudyContextAnchor = { ...anchor, itemVersionId: id(7), activityId: id(8) };
  const provider = vi.fn(async (_input, _signal, emit) => { await emit?.("hint"); return output; });
  const deliver = vi.fn(async () => receipt);
  const budget = { reserve: vi.fn(async () => ({ id: "reservation" })), claimExecution: async () => true,
    settle: vi.fn(async () => {}), release: vi.fn(async () => {}), markUnknown: vi.fn(async () => {}) };
  const resolve = vi.fn(async () => canonical);
  const service = createEphemeralTutorService({ provider: { complete: provider }, budget, sources: { listOwnedIds: async () => [] }, chunks: { listForSources: async () => [] },
    privacy: { snapshot: async () => ({ epoch: 1, excludedSourceIds: [] }), currentEpoch: async () => 1 },
    studyContext: { resolve }, exposures: { deliver }, requestKey: () => "unused-request-key",
    config: { maxContextCharacters: 12000, maxOutputTokens: 500, reservedCents: 10, inputCentsPerMillion: 1, outputCentsPerMillion: 1 } });
  await service.replyEphemeral(scope, { ...input, clientKey: "batch8-client-key", contextAnchor: requested }, undefined, () => {});
  expect(resolve).toHaveBeenCalledExactlyOnceWith(scope, requested, { courseId: undefined });
  expect(deliver).toHaveBeenCalledExactlyOnceWith(scope, { releaseKey: "ephemeral:batch8-client-key", contextAnchor: canonical,
    origin: "assistant", supportDomain: "unknown", kind: "hint", level: "hinted" });
});
it("preserves a released exposure if the consumer rejects a displayed delta", async () => {
  const f = fixture(async (_input, _signal, emit) => { await emit?.("visible"); return output; });
  const failure = new Error("synthetic consumer failure"), displayed = vi.fn(async () => { throw failure; });
  await expect(f.service.replyEphemeral(scope, input, undefined, displayed)).rejects.toBe(failure);
  expect(displayed).toHaveBeenCalledExactlyOnceWith("visible"); expect(f.deliver).toHaveBeenCalledOnce();
});
it("non-streaming response waits for exposure delivery and propagates failure", async () => {
  const f = fixture(async () => output); const failure = new Error("synthetic final exposure failure"); f.deliver.mockRejectedValueOnce(failure);
  await expect(f.service.replyEphemeral(scope, input)).rejects.toBe(failure);
  expect(f.deliver).toHaveBeenCalledOnce();
});
it("rejects a stale context after receipt release but before the first delta callback", async () => {
  let released = false;
  const f = fixture(async (_input, _signal, emit) => { await emit?.("withheld"); return output; }, {
    assertCurrent: async () => { if (released) throw Object.assign(new Error("synthetic pin changed"), { code: "CONFLICT" }); },
  });
  f.deliver.mockImplementation(async () => { released = true; return receipt; });
  const displayed = vi.fn();
  await expect(f.service.replyEphemeral(scope, input, undefined, displayed)).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
  expect(f.deliver).toHaveBeenCalledOnce(); expect(displayed).not.toHaveBeenCalled();
});
it("aborted generation before a first delta does not create a receipt or invoke the consumer", async () => {
  const controller = new AbortController();
  const f = fixture(async (_input, _signal, emit) => { controller.abort(); await emit?.("withheld"); return output; });
  const displayed = vi.fn();
  await expect(f.service.replyEphemeral(scope, input, controller.signal, displayed)).rejects.toMatchObject({ code: "ABORTED" });
  expect(f.deliver).not.toHaveBeenCalled(); expect(displayed).not.toHaveBeenCalled();
});
it("fails before provider or callback when an attempt context has no exposure recorder", async () => {
  const complete = vi.fn(async () => output), displayed = vi.fn();
  const budget = { reserve: vi.fn(async () => ({ id: "reservation" })), claimExecution: async () => true,
    settle: vi.fn(async () => {}), release: vi.fn(async () => {}), markUnknown: vi.fn(async () => {}) };
  const service = createEphemeralTutorService({ provider: { complete }, budget, sources: { listOwnedIds: async () => [] }, chunks: { listForSources: async () => [] },
    privacy: { snapshot: async () => ({ epoch: 1, excludedSourceIds: [] }), currentEpoch: async () => 1 }, studyContext: { resolve: async () => anchor },
    config: { maxContextCharacters: 12000, maxOutputTokens: 500, reservedCents: 10, inputCentsPerMillion: 1, outputCentsPerMillion: 1 } });
  await expect(service.replyEphemeral(scope, input, undefined, displayed)).rejects.toMatchObject({ code: "VALIDATION", status: 409 });
  expect(complete).not.toHaveBeenCalled(); expect(budget.reserve).not.toHaveBeenCalled(); expect(displayed).not.toHaveBeenCalled();
});
it("a context resolver rejection stops before provider, budget, or exposure", async () => {
  const failure = new Error("synthetic context unavailable");
  const complete = vi.fn(async () => output), f = fixture(complete, { resolve: async () => { throw failure; } });
  await expect(f.service.replyEphemeral(scope, input)).rejects.toBe(failure);
  expect(complete).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled(); expect(f.budget.reserve).not.toHaveBeenCalled();
});
it("a deterministic language response propagates receipt failure without provider or budget use", async () => {
  const language = { ...anchor, purpose: "language_support" as const }, failure = new Error("synthetic language receipt failure");
  const complete = vi.fn(async () => output), deliver = vi.fn(async () => { throw failure; });
  const budget = { reserve: vi.fn(async () => ({ id: "reservation" })), claimExecution: async () => true,
    settle: vi.fn(async () => {}), release: vi.fn(async () => {}), markUnknown: vi.fn(async () => {}) };
  const service = createEphemeralTutorService({ provider: { complete }, budget, sources: { listOwnedIds: async () => [] }, chunks: { listForSources: async () => [] },
    privacy: { snapshot: async () => ({ epoch: 1, excludedSourceIds: [] }), currentEpoch: async () => 1 },
    studyContext: { resolve: async () => language, languageSupport: async () => null }, exposures: { deliver },
    config: { maxContextCharacters: 12000, maxOutputTokens: 500, reservedCents: 10, inputCentsPerMillion: 1, outputCentsPerMillion: 1 } });
  await expect(service.replyEphemeral(scope, { ...input, text: "translate", contextAnchor: language })).rejects.toBe(failure);
  expect(deliver).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled(); expect(budget.reserve).not.toHaveBeenCalled();
});
it("a deterministic language response waits for its language-scoped receipt without provider or budget use", async () => {
  const language = { ...anchor, purpose: "language_support" as const }; const gate = deferred<StudyExposureReceipt>(), entered = deferred<void>();
  const complete = vi.fn(async () => output), delivered = vi.fn(() => { entered.resolve(); return gate.promise; });
  const budget = { reserve: vi.fn(async () => ({ id: "reservation" })), claimExecution: async () => true,
    settle: vi.fn(async () => {}), release: vi.fn(async () => {}), markUnknown: vi.fn(async () => {}) };
  const service = createEphemeralTutorService({ provider: { complete }, budget, sources: { listOwnedIds: async () => [] }, chunks: { listForSources: async () => [] },
    privacy: { snapshot: async () => ({ epoch: 1, excludedSourceIds: [] }), currentEpoch: async () => 1 },
    studyContext: { resolve: async () => language, languageSupport: async () => null }, exposures: { deliver: delivered },
    config: { maxContextCharacters: 12000, maxOutputTokens: 500, reservedCents: 10, inputCentsPerMillion: 1, outputCentsPerMillion: 1 } });
  let returned = false; const call = service.replyEphemeral(scope, { ...input, text: "translate", contextAnchor: language }).then(value => { returned = true; return value; });
  const settled = call.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  try {
    const arrival = await Promise.race([entered.promise.then(() => ({ entered: true as const })), settled.then(result => ({ entered: false as const, result }))]);
    if (!arrival.entered && !arrival.result.ok) throw arrival.result.error;
    expect(arrival.entered).toBe(true); expect(returned).toBe(false);
  } finally { gate.resolve(receipt); await settled; }
  expect((await call).exposureReceipt).toEqual(receipt);
  expect(delivered).toHaveBeenCalledWith(scope, expect.objectContaining({ contextAnchor: language, origin: "assistant", supportDomain: "language", kind: "hint", level: "hinted" }));
  expect(complete).not.toHaveBeenCalled(); expect(budget.reserve).not.toHaveBeenCalled();
});
