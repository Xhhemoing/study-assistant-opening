import { describe, expect, it, vi } from "vitest";
import type { OpeningAiGradingServiceDeps } from "@aistudy/ai";
import type { LearningObservation } from "@aistudy/contracts";
import type { OpeningJobRecord } from "@aistudy/database";
import { createGradeObservationHandler } from "./grade-observation";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const payload = { observationId: id(3), rootObservationId: id(3), answerRevision: 1 };
const job: OpeningJobRecord = { id: id(4), workspaceId: id(1), ownerUserId: id(2), kind: "grade-observation",
  key: `ai-grade:${id(1)}:${id(3)}:1`, payload, state: "running", result: null, privacyEpoch: 2, claimToken: id(5) };
const original = { id: id(3), rootObservationId: id(3), answer: "1" } as LearningObservation;
const graded = { ...original, id: id(6) };
function setup() {
  let cancelled = false;
  const assertLease = () => { if (cancelled) throw Object.assign(new Error("lease cancelled"), { code: "CONFLICT" }); };
  const repository = {
    context: vi.fn(async () => { assertLease(); return { observation: original, existing: null, answerRevision: 1,
      operationId: job.key, stem: "1/2+1/2?", referenceText: "1", misconceptions: [], workSource: null,
      materialProvenance: { materialAnswerRefs: [], materialSourceRefs: [] } }; }),
    ledger: vi.fn(async () => "unsent" as const),
    apply: vi.fn<OpeningAiGradingServiceDeps["repository"]["apply"]>(async () => { assertLease(); return graded; }),
  };
  const gateway = { call: vi.fn<OpeningAiGradingServiceDeps["gateway"]["call"]>(async (_scope, _task, options) => {
    await options.beforeSend?.();
    const output = { text: JSON.stringify({ outcome: "correct", confidence: .95, questionMatch: true, feedback: "正确",
      criteria: [{ label: "计算", verdict: "correct", feedback: "1" }] }), inputTokens: 1, outputTokens: 1 };
    await options.persistResult?.(output, { reservationId: id(7), settledCents: 1 });
    return output;
  }) };
  const deps: OpeningAiGradingServiceDeps = { repository, gateway, images: vi.fn(async () => []), budget: () => ({} as never) };
  return { repository, gateway, handler: createGradeObservationHandler(deps), cancel: () => { cancelled = true; } };
}

describe("durable grading handler", () => {
  it("runs without a browser abort signal and passes execution fences to pre-send and publication", async () => {
    const f = setup();
    expect(await f.handler(job, payload)).toEqual({ observationId: graded.id, rootObservationId: original.id, answerRevision: 1 });
    const options = f.gateway.call.mock.calls[0]![2];
    expect(options.signal).toBeUndefined();
    expect(f.repository.apply.mock.calls[0]?.[0]).toMatchObject({ jobExecution: { id: job.id, token: job.claimToken, privacyEpoch: 2 } });
  });
  it.each([{ ...payload, answerRevision: 2 }, { ...payload, rootObservationId: id(8) }])("rejects a mismatched sealed revision before calling a provider: %j", async raw => {
    const f = setup();
    await expect(f.handler(job, raw)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.gateway.call).not.toHaveBeenCalled();
  });
  it("requires a real execution claim", async () => {
    const f = setup();
    await expect(f.handler({ ...job, claimToken: undefined }, payload)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.repository.context).not.toHaveBeenCalled();
  });
  it("does not publish a result arriving after lease cancellation", async () => {
    const f = setup();
    f.gateway.call.mockImplementation(async (_scope, _task, options) => {
      await options.beforeSend?.(); f.cancel();
      await options.persistResult?.({ text: JSON.stringify({ outcome: "correct", confidence: .95, questionMatch: true, feedback: "正确",
        criteria: [{ label: "计算", verdict: "correct", feedback: "1" }] }), inputTokens: 1, outputTokens: 1 }, { reservationId: id(7), settledCents: 1 });
      throw new Error("unreachable");
    });
    await expect(f.handler(job, payload)).rejects.toThrow("lease cancelled");
    expect(f.repository.apply).toHaveBeenCalledTimes(1);
  });
});
