import { describe, expect, it, vi } from "vitest";
import { LearningAdviceRequestModel, parseLearningAdviceResponse,
  type LearningAdviceContext, type LearningAdviceTransport } from "./learning-advice-request-model";

const context: LearningAdviceContext = { actorKey: "private-actor", courseId: "private-course", activityId: "private-activity",
  attemptId: "private-attempt", revision: 7, accessEpoch: 1 };
const ruleDecision = { activityKind: "diagnose", reasonCode: "no_evidence" };
const off = { advice: { ruleDecision, status: "disabled", experimentalAdvice: null }, experimentState: "off", messageCode: "off" };
const compared = { advice: { ruleDecision, status: "compared", experimentalAdvice: { kind: "supported_practice" } },
  experimentState: "ready", messageCode: "compared" };
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const pending: ReturnType<typeof deferred>[] = [];
  const transport = vi.fn<LearningAdviceTransport>(() => { const next = deferred(); pending.push(next); return next.promise; });
  return { model: new LearningAdviceRequestModel(transport), transport, pending };
}
async function flush() { await Promise.resolve(); await Promise.resolve(); }

describe("draft strict response boundary (not authentication)", () => {
  it.each([off, compared,
    { advice: null, experimentState: "off", messageCode: "off" },
    { advice: null, experimentState: "unavailable", messageCode: "unavailable" },
    { advice: { ruleDecision, status: "unavailable", experimentalAdvice: null }, experimentState: "unavailable", messageCode: "unavailable" },
    { advice: { ruleDecision, status: "fallback", experimentalAdvice: null, reason: "insufficient_samples" }, experimentState: "ready", messageCode: "fallback" },
  ])("accepts safe off/unavailable/null/fallback/compared: %j", value => {
    expect(parseLearningAdviceResponse(value)).toEqual(value);
  });
  it.each([
    { ...compared, probability: 0.99 }, { ...compared, dataAsOf: "private-time" },
    { ...compared, advice: { ...compared.advice, sourceIds: ["private"] } },
    { ...compared, advice: { ...compared.advice, ruleDecision: { ...ruleDecision, ownerId: "private" } } },
    { ...compared, advice: { ...compared.advice, experimentalAdvice: { kind: "continue_rule", probability: 0.98 } } },
    { ...compared, advice: { ...compared.advice, experimentalAdvice: { kind: "mastery" } } },
    { ...compared, advice: { ...compared.advice, ruleDecision: { activityKind: "exam", reasonCode: "no_evidence" } } },
    { ...compared, advice: { ...compared.advice, ruleDecision: { ...ruleDecision, reasonCode: "private-raw-reason" } } },
    { ...compared, experimentState: "off" }, { ...compared, experimentState: "unavailable", messageCode: "unavailable" },
    { ...compared, advice: null }, { ...off, experimentState: "ready" }, { ...off, messageCode: "private-error" },
    { ...off, experimentState: "loading" }, compared.advice, null,
  ])("rejects extras, bare safe ports and contradictory states: %j", value => {
    expect(() => parseLearningAdviceResponse(value)).toThrow();
  });
});

it("starts off, reads only false; true is explicit intent, not a synthesized comparison/grant", async () => {
  const { model, transport, pending } = fixture();
  expect(model.getSnapshot()).toMatchObject({ optedIn: false, status: "idle", advice: null, rule: null });
  model.setOptIn(true); expect(transport).not.toHaveBeenCalled();
  model.setContext(context);
  expect(transport.mock.calls[0]![0]).toEqual({ activityId: context.activityId,
    body: { attemptId: context.attemptId, expectedRevision: 7, optIn: false }, signal: expect.any(AbortSignal) });
  expect(Object.keys(transport.mock.calls[0]![0].body).sort()).toEqual(["attemptId", "expectedRevision", "optIn"]);
  pending[0]!.resolve(off); await flush();
  model.setOptIn(true);
  expect(model.getSnapshot()).toMatchObject({ status: "loading", advice: null, rule: ruleDecision });
  pending[1]!.resolve(off); await flush();
  expect(model.getSnapshot()).toMatchObject({ optedIn: true, status: "off", advice: off.advice });
  expect(JSON.stringify(transport.mock.calls)).not.toMatch(/actor|course|grant|target|cutoff|scope/);
});

it("refuses unsolicited comparison even though the safe DTO parses", async () => {
  const { model, pending } = fixture(); model.setContext(context);
  pending[0]!.resolve(compared); await flush();
  expect(model.getSnapshot()).toMatchObject({ optedIn: false, status: "unavailable", advice: null, rule: null });
  expect(model.getSnapshot().error).toBeInstanceOf(Error);
});

it("abort plus generation prevents late resolve/reject and reverse-order opt-in replies", async () => {
  const { model, transport, pending } = fixture(); model.setContext(context);
  pending[0]!.resolve(off); await flush();
  model.setOptIn(true); const firstSignal = transport.mock.calls[1]![0].signal;
  model.setOptIn(false);
  expect(firstSignal.aborted).toBe(true);
  expect(model.getSnapshot()).toMatchObject({ optedIn: false, advice: null, rule: ruleDecision });
  model.setOptIn(true);
  pending[3]!.resolve({ ...compared, advice: { ...compared.advice, experimentalAdvice: { kind: "continue_rule" } } }); await flush();
  pending[1]!.resolve(compared); pending[2]!.reject(new Error("late private error")); await flush();
  expect(model.getSnapshot()).toMatchObject({ status: "ready", advice: { experimentalAdvice: { kind: "continue_rule" } }, error: null });
  model.setOptIn(false);
  expect(model.getSnapshot().advice).toBeNull();
  pending[4]!.resolve({ advice: null, experimentState: "off", messageCode: "off" }); await flush();
  expect(model.getSnapshot()).toMatchObject({ status: "off", rule: null, advice: null });
});

it.each(["actorKey", "courseId", "activityId", "attemptId", "revision", "accessEpoch"] as const)("clears results and aborts on %s changes before new replies", async key => {
  const { model, transport, pending } = fixture(); model.setContext(context);
  pending[0]!.resolve(off); await flush(); model.setOptIn(true);
  pending[1]!.resolve(compared); await flush(); model.setOptIn(true);
  const old = transport.mock.calls[2]![0].signal;
  const next = { ...context, [key]: typeof context[key] === "number" ? 8 : "other-private" } as LearningAdviceContext;
  model.setContext(next);
  expect(old.aborted).toBe(true);
  expect(model.getSnapshot()).toMatchObject({ optedIn: false, rule: null, advice: null, status: "loading" });
  expect(transport.mock.calls[3]![0].body.optIn).toBe(false);
  pending[2]!.resolve(compared); await flush();
  expect(model.getSnapshot().rule).toBeNull();
  pending[3]!.resolve(off); await flush();
  expect(model.getSnapshot()).toMatchObject({ status: "off", optedIn: false, rule: ruleDecision });
});

it("same context does not refetch; A→B→A still invalidates A's first generation", async () => {
  const { model, transport, pending } = fixture(); model.setContext(context);
  model.setContext({ ...context }); expect(transport).toHaveBeenCalledTimes(1);
  model.setContext({ ...context, actorKey: "B" }); model.setContext(context);
  pending[0]!.resolve(off); pending[1]!.resolve(off); await flush();
  expect(model.getSnapshot().rule).toBeNull();
  pending[2]!.resolve(off); await flush(); expect(model.getSnapshot().rule).toEqual(ruleDecision);
});

it("logout, blocked execution and teardown use null/clear and cannot be resurrected", async () => {
  const { model, transport, pending } = fixture(); model.setContext(context); model.setOptIn(true);
  model.setContext(null);
  expect(transport.mock.calls.every(([request]) => request.signal.aborted)).toBe(true);
  pending.forEach(row => row.resolve(compared)); await flush();
  expect(model.getSnapshot()).toMatchObject({ status: "idle", optedIn: false, rule: null, advice: null });
  model.retry(); model.setOptIn(true); expect(transport).toHaveBeenCalledTimes(2);
  model.setContext(context); model.clear(); pending[2]!.reject(new Error("late")); await flush();
  expect(model.getSnapshot()).toMatchObject({ status: "idle", error: null });
});

it("known access/visibility reset clears opt-in and rule; suspended work never updates", async () => {
  const { model, transport, pending } = fixture(); model.setContext(context);
  pending[0]!.resolve(off); await flush(); model.setOptIn(true);
  model.suspend(); expect(transport.mock.calls[1]![0].signal.aborted).toBe(true);
  pending[1]!.resolve(compared); await flush();
  expect(model.getSnapshot()).toMatchObject({ status: "idle", optedIn: false, rule: null, advice: null });
  model.refresh(); expect(transport.mock.calls[2]![0].body.optIn).toBe(false);
  pending[2]!.resolve(off); await flush(); model.setOptIn(true); pending[3]!.resolve(compared); await flush();
  model.refresh(); expect(model.getSnapshot()).toMatchObject({ optedIn: false, rule: null, advice: null });
});

it.each([new Error("private transport failure"), new DOMException("private timeout", "TimeoutError"),
  new DOMException("unexpected abort", "AbortError"), { privateReason: "do not render" }])("keeps original failure identity without fake ready or automatic retry: %j", async error => {
  const { model, transport, pending } = fixture(); model.setContext(context);
  pending[0]!.resolve(off); await flush(); model.setOptIn(true);
  pending[1]!.reject(error); await flush();
  expect(model.getSnapshot()).toMatchObject({ status: "unavailable", advice: null, rule: ruleDecision });
  expect(model.getSnapshot().error).toBe(error); expect(transport).toHaveBeenCalledTimes(2);
  model.retry(); expect(transport.mock.calls[2]![0].body.optIn).toBe(true);
  pending[2]!.resolve({ advice: null, experimentState: "unavailable", messageCode: "unavailable" }); await flush();
  expect(model.getSnapshot()).toMatchObject({ status: "unavailable", rule: null, error: null });
});

it("handles sync transport failure and parse failure, not just rejected promises", async () => {
  const error = new Error("original");
  const model = new LearningAdviceRequestModel(() => { throw error; }); model.setContext(context);
  expect(model.getSnapshot()).toMatchObject({ status: "unavailable", rule: null, advice: null });
  expect(model.getSnapshot().error).toBe(error);
  const f = fixture(); f.model.setContext(context); f.pending[0]!.resolve(off); await flush(); f.model.setOptIn(true);
  f.pending[1]!.resolve({ ...compared, privateIds: ["never display"] }); await flush();
  expect(f.model.getSnapshot()).toMatchObject({ status: "unavailable", rule: ruleDecision, advice: null });
  expect(f.model.getSnapshot().error).toBeInstanceOf(Error);
});

it("outer opt-out owns abort cleanup reentry; every nested controller is cancelled", async () => {
  const { model, transport, pending } = fixture(); model.setContext(context);
  pending[0]!.resolve(off); await flush(); model.setOptIn(true);
  transport.mock.calls[1]![0].signal.addEventListener("abort", () => {
    model.setOptIn(true);
    transport.mock.calls[2]![0].signal.addEventListener("abort", () => model.retry(), { once: true });
  }, { once: true });
  model.setOptIn(false);
  expect(transport.mock.calls.map(([request]) => request.body.optIn)).toEqual([false, true, true, true, false]);
  expect(transport.mock.calls.slice(1).map(([request]) => request.signal.aborted)).toEqual([true, true, true, false]);
  pending[2]!.resolve(compared); pending[3]!.reject(new Error("late nested failure")); await flush();
  expect(model.getSnapshot()).toMatchObject({ optedIn: false, status: "loading", advice: null, error: null });
  pending[4]!.resolve(off); pending[1]!.resolve(compared); await flush();
  expect(model.getSnapshot()).toMatchObject({ optedIn: false, status: "off", advice: null, error: null });
  model.setOptIn(true); pending[5]!.resolve(compared); await flush();
  expect(model.getSnapshot()).toMatchObject({ optedIn: true, status: "ready", advice: compared.advice });
});

it.each(["opt-out", "suspend", "clear", "retry", "context"] as const)("loading subscriber %s supersedes before dispatch", async action => {
  const { model, transport, pending } = fixture(); model.setContext(context);
  pending[0]!.resolve(off); await flush();
  let once = false;
  model.subscribe(() => {
    if (once || model.getSnapshot().status !== "loading" || !model.getSnapshot().optedIn) return;
    once = true;
    if (action === "opt-out") model.setOptIn(false);
    else if (action === "suspend") model.suspend();
    else if (action === "clear") model.clear();
    else if (action === "retry") model.retry();
    else model.setContext({ ...context, actorKey: "new-actor" });
  });
  model.setOptIn(true);
  const continues = action === "opt-out" || action === "retry" || action === "context";
  expect(transport).toHaveBeenCalledTimes(continues ? 2 : 1);
  expect(transport.mock.calls.every(([request]) => !request.signal.aborted)).toBe(true);
  if (continues) {
    expect(transport.mock.calls[1]![0].body.optIn).toBe(action === "retry");
    pending[1]!.resolve(action === "retry" ? compared : off); await flush();
    expect(model.getSnapshot()).toMatchObject({ status: action === "retry" ? "ready" : "off", optedIn: action === "retry" });
  } else expect(model.getSnapshot()).toMatchObject({ status: "idle", optedIn: false, rule: null, advice: null });
});

it.each(["clear", "suspend", "refresh", "context"] as const)("%s cancels abort-listener retries and preserves context identity", async action => {
  const { model, transport, pending } = fixture(); model.setContext(context); model.setOptIn(true);
  transport.mock.calls[1]![0].signal.addEventListener("abort", () => model.retry(), { once: true });
  if (action === "context") model.setContext({ ...context, actorKey: "new-actor" });
  else model[action]();
  expect(transport.mock.calls.slice(0, 3).every(([request]) => request.signal.aborted)).toBe(true);
  pending.slice(0, 3).forEach(row => row.resolve(compared)); await flush();
  expect(model.getSnapshot()).toMatchObject({ optedIn: false, advice: null, rule: null, error: null });
  expect(model.getSnapshot().status).toBe(action === "refresh" || action === "context" ? "loading" : "idle");
  if (action === "refresh" || action === "context") {
    expect(transport.mock.calls[3]![0].body.optIn).toBe(false);
    pending[3]!.resolve(off); await flush(); expect(model.getSnapshot().status).toBe("off");
  }
});

it("abort callback identity switch resets intent and leaves a cancellable rule-only request", async () => {
  const { model, transport, pending } = fixture(); model.setContext(context); model.setOptIn(true);
  transport.mock.calls[1]![0].signal.addEventListener("abort", () => {
    model.setContext({ ...context, activityId: "new-activity", attemptId: "new-attempt" });
  }, { once: true });
  model.setOptIn(true);
  expect(transport.mock.calls.map(([request]) => request.signal.aborted)).toEqual([true, true, true, false]);
  expect(transport.mock.calls[3]![0]).toMatchObject({ activityId: "new-activity", body: { attemptId: "new-attempt", optIn: false } });
  pending[1]!.resolve(compared); pending[2]!.resolve(off); await flush();
  expect(model.getSnapshot()).toMatchObject({ optedIn: false, status: "loading", rule: null, advice: null });
  pending[3]!.resolve(off); await flush(); expect(model.getSnapshot().status).toBe("off");
});

it("clear-state subscriber teardown prevents a reset from starting another request", () => {
  const { model, transport } = fixture(); model.setContext(context);
  let once = false;
  model.subscribe(() => { if (!once && model.getSnapshot().status === "idle") { once = true; model.clear(); } });
  model.refresh();
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0]![0].signal.aborted).toBe(true);
  expect(model.getSnapshot()).toMatchObject({ status: "idle", optedIn: false });
});

it("transport callback reentry and result subscribers cannot steal the latest controller", async () => {
  const pending: ReturnType<typeof deferred>[] = [];
  const transport = vi.fn<LearningAdviceTransport>(() => {
    const row = deferred(); const index = pending.push(row) - 1;
    if (index === 1) model.setOptIn(false);
    return row.promise;
  });
  const model = new LearningAdviceRequestModel(transport); model.setContext(context);
  pending[0]!.resolve(off); await flush(); model.setOptIn(true);
  expect(transport.mock.calls[1]![0].signal.aborted).toBe(true);
  pending[1]!.resolve(compared); await flush();
  expect(model.getSnapshot()).toMatchObject({ optedIn: false, status: "loading", advice: null });
  let once = false;
  model.subscribe(() => { if (!once && model.getSnapshot().status === "off") { once = true; model.retry(); } });
  pending[2]!.resolve(off); await flush();
  expect(model.getSnapshot().status).toBe("loading");
  model.clear(); expect(transport.mock.calls[3]![0].signal.aborted).toBe(true);
  pending[3]!.reject(new Error("late retry")); await flush();
  expect(model.getSnapshot()).toMatchObject({ status: "idle", error: null });
});

it("rechecks ownership after response parsing callbacks", async () => {
  const { model, pending } = fixture(); model.setContext(context); model.setOptIn(true);
  pending[1]!.resolve({ ...compared, get advice() { model.clear(); return compared.advice; } });
  await flush(); expect(model.getSnapshot()).toMatchObject({ status: "idle", optedIn: false, advice: null, rule: null });
});

it("repeated retries each retain a cancellable identity; latest response alone is accepted", async () => {
  const { model, transport, pending } = fixture(); model.setContext(context); model.retry(); model.retry();
  expect(transport.mock.calls.map(([request]) => request.signal.aborted)).toEqual([true, true, false]);
  pending[2]!.resolve(off); await flush(); pending[0]!.resolve(compared); pending[1]!.reject(new Error("old retry")); await flush();
  expect(model.getSnapshot()).toMatchObject({ status: "off", optedIn: false, error: null });
});

it("copies context, does not mutate caller data and unsubscribes listeners", async () => {
  const { model, pending } = fixture(); const input = { ...context }; const before = structuredClone(off);
  const listener = vi.fn(); const unsubscribe = model.subscribe(listener);
  model.setContext(input); input.actorKey = "mutated-caller";
  pending[0]!.resolve(off); await flush(); expect(off).toEqual(before);
  expect(listener).toHaveBeenCalledTimes(3); unsubscribe(); model.clear(); expect(listener).toHaveBeenCalledTimes(3);
});
