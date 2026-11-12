import { describe, expect, it, vi } from "vitest";
import {
  createLearningAdviceHttp, LearningAdviceHttpError,
  type LearningAdviceHttpFetch, type LearningAdviceHttpRequest, type LearningAdviceHttpResponse,
} from "./learning-advice-http";

const activityId = "00000000-0000-4000-8000-000000000001";
const attemptId = "00000000-0000-4000-8000-000000000002";
const rule = { activityKind: "diagnose", reasonCode: "no_evidence" };
const disabled = () => ({ ruleDecision: { ...rule }, status: "disabled", experimentalAdvice: null });
const available = () => ({ experimentState: "off", messageCode: "rule_only", advice: disabled() });
const unavailable = () => ({ experimentState: "off", messageCode: "advice_unavailable", advice: null });
const request = (signal = new AbortController().signal): LearningAdviceHttpRequest => ({
  activityId, body: { attemptId, expectedRevision: 3, optIn: false }, signal,
});
function setup(raw: unknown = available(), status = 200, redirected = false) {
  const json = vi.fn(async (): Promise<unknown> => raw);
  const fetchImpl = vi.fn<LearningAdviceHttpFetch>(async () => ({ status, redirected, json }));
  return { json, fetchImpl, transport: createLearningAdviceHttp(fetchImpl) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("learning advice off-only HTTP transport", () => {
  it.each([false, true])("posts exact same-origin options and whitelisted body (optIn=%s)", async optIn => {
    const { transport, fetchImpl } = setup();
    const input = { ...request(), actorKey: "private-actor", accessEpoch: 99, grant: "not-a-grant" };
    input.body.optIn = optIn;
    const result: LearningAdviceHttpResponse = await transport(input);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(`/api/opening/teaching/activities/${activityId}/learning-advice`, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", cache: "no-store",
      redirect: "error", signal: input.signal, body: JSON.stringify({ attemptId, expectedRevision: 3, optIn }),
    });
    expect(fetchImpl.mock.calls[0]![1].signal).toBe(input.signal);
    expect(result).toEqual({ experimentState: "off", messageCode: "off", advice: disabled() });
  });

  it("preserves a legal disabled port, but constructs detached DTO objects", async () => {
    const raw = available();
    const { transport } = setup(raw);
    const result = await transport(request());
    expect(result.advice).toEqual(raw.advice);
    expect(result.advice).not.toBe(raw.advice);
    expect(result.advice!.ruleDecision).not.toBe(raw.advice.ruleDecision);
    raw.advice.ruleDecision.reasonCode = "private-value";
    expect(result.advice!.ruleDecision.reasonCode).toBe("no_evidence");
  });

  it("maps unavailable rule data to off/off/null, never a successful experiment", async () => {
    const { transport } = setup(unavailable());
    expect(await transport(request())).toEqual({ experimentState: "off", messageCode: "off", advice: null });
  });

  it.each(["diagnose", "targeted_explain", "reduced_help_practice", "transfer_check", "full_explain"])("accepts legal activity %s", async activityKind => {
    const raw = available(); raw.advice.ruleDecision.activityKind = activityKind;
    expect((await setup(raw).transport(request())).advice!.ruleDecision.activityKind).toBe(activityKind);
  });
  it.each(["due_retest", "remediation_limit", "requested_consolidate", "requested_full", "no_evidence", "unverified_only",
    "verified_incorrect", "repeated_assisted_error", "assisted_success", "assistance_dependent", "independent",
    "correct_needs_independent_check", "needs_check"])("accepts legal reason %s", async reasonCode => {
    const raw = available(); raw.advice.ruleDecision.reasonCode = reasonCode;
    expect((await setup(raw).transport(request())).advice!.ruleDecision.reasonCode).toBe(reasonCode);
  });

  it.each([
    null, [], "not-json-object", {},
    { ...available(), experimentState: "ready" }, { ...available(), experimentState: "OFF" },
    { ...available(), messageCode: "off" }, { ...available(), messageCode: "fallback" },
    { ...available(), advice: null }, { ...unavailable(), advice: disabled() },
    ...["compared", "fallback", "unavailable", "DISABLED"].map(status => ({ ...available(), advice: { ...disabled(), status } })),
    { ...available(), advice: { ...disabled(), experimentalAdvice: { kind: "supported_practice" } } },
    { ...available(), advice: { ...disabled(), ruleDecision: { ...rule, activityKind: "practice" } } },
    { ...available(), advice: { ...disabled(), ruleDecision: { ...rule, reasonCode: "unknown" } } },
    { ...available(), advice: { ...disabled(), ruleDecision: { ...rule, reasonCode: null } } },
  ])("rejects unsupported/contradictory complete raw payload %#", async raw => {
    const { transport, fetchImpl, json } = setup(raw);
    await expect(transport(request())).rejects.toBeInstanceOf(Error);
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(json).toHaveBeenCalledTimes(1);
  });

  it.each(["unknown", "privateProbability", "probability", "activityId", "attemptId", "actorKey", "grant", "source", "dataAsOf"])(
    "does not wash unknown/private field %s out before strict parsing at any depth", async key => {
      for (const depth of [0, 1, 2]) {
        const raw = available();
        const target = [raw, raw.advice, raw.advice.ruleDecision][depth]!;
        Object.defineProperty(target, key, { enumerable: true, value: "secret" });
        await expect(setup(raw).transport(request())).rejects.toBeInstanceOf(Error);
      }
      await expect(setup({ ...unavailable(), [key]: "secret" }).transport(request())).rejects.toBeInstanceOf(Error);
    });

  it.each([0, 1, 2])("rejects response accessors without invoking them at depth %i", async depth => {
    const raw = available();
    const target = [raw, raw.advice, raw.advice.ruleDecision][depth]!;
    const key = ["advice", "ruleDecision", "activityKind"][depth]!;
    const getter = vi.fn(() => { throw new Error("must not execute"); });
    Object.defineProperty(target, key, { enumerable: true, get: getter });
    await expect(setup(raw).transport(request())).rejects.toBeInstanceOf(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects hidden/symbol fields, arrays, inherited values and cyclic data", async () => {
    const hidden = available(); Object.defineProperty(hidden, "secret", { value: 1 });
    const symbol = available(); Object.defineProperty(symbol, Symbol("secret"), { enumerable: true, value: 1 });
    const cycle = available(); Object.assign(cycle.advice.ruleDecision, { cycle });
    const inherited = Object.create(available()) as unknown;
    for (const raw of [hidden, symbol, cycle, inherited, { ...available(), advice: [] }]) {
      await expect(setup(raw).transport(request())).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("accepts null-prototype plain data records", async () => {
    const raw: unknown = Object.assign(Object.create(null), unavailable());
    expect(await setup(raw).transport(request())).toEqual({ experimentState: "off", messageCode: "off", advice: null });
  });

  it.each(["body", "activityId", "signal"])("rejects request accessor %s before reading it or fetching", async key => {
    const input = request(); const getter = vi.fn(() => { throw new Error("must not execute"); });
    Object.defineProperty(input, key, { enumerable: true, get: getter });
    const { transport, fetchImpl } = setup();
    await expect(transport(input)).rejects.toBeInstanceOf(TypeError);
    expect(getter).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["attemptId", "expectedRevision", "optIn", "unknown"])("rejects body accessor %s without executing it", async key => {
    const input = request(); const getter = vi.fn(() => "secret");
    Object.defineProperty(input.body, key, { enumerable: true, get: getter });
    const { transport, fetchImpl } = setup();
    await expect(transport(input)).rejects.toBeInstanceOf(TypeError);
    expect(getter).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    { activityId: "https://untrusted.example" }, { activityId: "../redirect" },
    { body: { attemptId: "bad", expectedRevision: 1, optIn: false } },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity].map(expectedRevision => ({ body: { attemptId, expectedRevision, optIn: false } })),
    { body: { attemptId, expectedRevision: 1, optIn: "true" } },
    { body: { attemptId, expectedRevision: 1, optIn: false, grant: "secret" } },
  ])("rejects invalid input before fetch %#", async patch => {
    const { transport, fetchImpl } = setup();
    await expect(transport({ ...request(), ...patch } as LearningAdviceHttpRequest)).rejects.toBeInstanceOf(Error);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([199, 301, 302, 307, 308, 400, 401, 403, 409, 429, 500, 503])("creates one safe HTTP error for status %i without reading raw/body", async status => {
    const { transport, json, fetchImpl } = setup({ secret: "private-body" }, status);
    const caught: unknown = await transport(request()).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(LearningAdviceHttpError);
    expect((caught as LearningAdviceHttpError).status).toBe(status);
    expect(Object.keys(caught as object).sort()).toEqual(["name", "status"]);
    expect((caught as Error).message).toBe("Learning advice request failed");
    expect((caught as Error).cause).toBeUndefined();
    expect(json).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects a followed redirect even if an injected transport reports 200", async () => {
    const { transport, json } = setup(available(), 200, true);
    await expect(transport(request())).rejects.toBeInstanceOf(LearningAdviceHttpError);
    expect(json).not.toHaveBeenCalled();
  });
  it.each([new TypeError("network failure"), new DOMException("stopped", "AbortError"), { opaque: "transport failure" }])(
    "passes network/redirect/abort rejection identity through without retry", async error => {
      const fetchImpl = vi.fn<LearningAdviceHttpFetch>().mockRejectedValue(error);
      await expect(createLearningAdviceHttp(fetchImpl)(request())).rejects.toBe(error);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  it.each([new SyntaxError("malformed JSON"), new DOMException("JSON aborted", "AbortError"), { opaque: "json failure" }])(
    "passes JSON rejection identity through", async error => {
      const { transport, json, fetchImpl } = setup(); json.mockRejectedValueOnce(error);
      await expect(transport(request())).rejects.toBe(error);
      expect(json).toHaveBeenCalledTimes(1); expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  it("rejects bad JSON rather than treating it as unavailable advice", async () => {
    const json = vi.fn(async (): Promise<unknown> => JSON.parse("{bad-json"));
    const fetchImpl = vi.fn<LearningAdviceHttpFetch>(async () => ({ status: 200, redirected: false, json }));
    await expect(createLearningAdviceHttp(fetchImpl)(request())).rejects.toBeInstanceOf(SyntaxError);
    expect(json).toHaveBeenCalledTimes(1);
  });
  it("does not fetch on pre-abort and preserves custom reason identity", async () => {
    const controller = new AbortController(); const reason = { abort: "before" }; controller.abort(reason);
    const { transport, fetchImpl } = setup();
    await expect(transport(request(controller.signal))).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("checks late abort after fetch even when the fake fetch ignores cancellation", async () => {
    const controller = new AbortController(); const reason = { abort: "after fetch" };
    const pending = deferred<Awaited<ReturnType<LearningAdviceHttpFetch>>>(); const json = vi.fn();
    const fetchImpl = vi.fn<LearningAdviceHttpFetch>(() => pending.promise);
    const result = createLearningAdviceHttp(fetchImpl)(request(controller.signal));
    const rejected = expect(result).rejects.toBe(reason);
    controller.abort(reason); pending.resolve({ status: 200, redirected: false, json });
    await rejected; expect(json).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls[0]![1].signal).toBe(controller.signal);
  });
  it("checks late abort after JSON without publishing an off success", async () => {
    const controller = new AbortController(); const reason = new Error("late abort");
    const pending = deferred<unknown>(); const started = deferred<void>();
    const fetchImpl = vi.fn<LearningAdviceHttpFetch>(async () => ({ status: 200, redirected: false,
      json: () => { started.resolve(); return pending.promise; } }));
    const result = createLearningAdviceHttp(fetchImpl)(request(controller.signal));
    const rejected = expect(result).rejects.toBe(reason);
    await started.promise; controller.abort(reason); pending.resolve(available());
    await rejected;
  });
  it("does not replace a JSON error with an abort reason if JSON itself rejects", async () => {
    const controller = new AbortController(); const original = new SyntaxError("json failure");
    const { transport, json } = setup();
    json.mockImplementationOnce(async () => { controller.abort(new Error("different")); throw original; });
    await expect(transport(request(controller.signal))).rejects.toBe(original);
  });
});
