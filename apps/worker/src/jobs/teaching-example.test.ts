import { createModelGateway } from "@aistudy/ai";
import { expect, it, vi } from "vitest";
import { createTeachingExampleHandler } from "./teaching-example";
const id = "11111111-1111-4111-8111-111111111111";
const target = { activityId: id, documentId: id, revisionNumber: 1, blockId: id, contentVersion: 1 };
const payload = { mode: "example", request: { clientKey: "example-01", target, consentVersion: "teaching-example-paid-v1", acceptPaidGeneration: true }, originalExample: "求 $\\int x^2 dx$。", sourceRefs: [{ sourceId: id, version: 1 }],
  purposePin: { courseId: null, materialUse: "teaching", sources: [] }, activitySourceIds: [], blocks: [], blockOrder: [], estimatedCents: 1 };
const job = { id, workspaceId: id, ownerUserId: id, key: "teaching-example:example-01", kind: "compile-teaching-unit", payload, result: null, state: "running", privacyEpoch: 0, claimToken: id };
function fixture() {
  let published = false;
  const read = vi.fn(async () => ({ publication: published ? { exampleBlockId: id } : null } as never));
  const repository = { read, ledger: vi.fn(async () => "unsent" as const), assertCurrent: vi.fn(async () => {}), publish: vi.fn(async () => { published = true; return {} as never; }) };
  const gateway = { call: vi.fn(async (_scope, _task, options) => { await options.beforeSend(); await options.persistResult({ text: JSON.stringify({ problem: "求 $\\int x^3 dx$。", workedSolution: "幂函数积分，得 $x^4/4+C$；求导核对。" }) }); return {} as never; }) };
  const handler = createTeachingExampleHandler({ repository, gateway, budget: () => ({} as never) });
  return { repository, gateway, handler };
}
it("publishes via gateway persistence and returns only a durable result", async () => {
  const f = fixture(); expect((await f.handler(job, payload)).publication).toBeTruthy();
  expect(f.repository.assertCurrent).toHaveBeenCalledTimes(2);
  expect(f.gateway.call.mock.calls[0]![1]).toBe("practice.grade-text");
  expect(f.gateway.call.mock.calls[0]![2].operationId).toBe(`teaching-example:${id}`);
  expect(f.repository.publish).toHaveBeenCalledTimes(1);
});
it("replays a published result without another provider call", async () => {
  const f = fixture(); await f.handler(job, payload); await f.handler(job, payload);
  expect(f.gateway.call).toHaveBeenCalledTimes(1);
});
it("refuses unknown ledger and stale source before generating", async () => {
  const f = fixture(); f.repository.ledger.mockResolvedValue("unknown" as never);
  await expect(f.handler(job, payload)).rejects.toThrow("不会重发"); expect(f.gateway.call).not.toHaveBeenCalled();
  const stale = fixture(); stale.repository.assertCurrent.mockRejectedValue(new Error("source changed"));
  await expect(stale.handler(job, payload)).rejects.toThrow("source changed"); expect(stale.gateway.call).not.toHaveBeenCalled();
});
it("does not equate model completion without persistence to success", async () => {
  const f = fixture(); f.gateway.call.mockImplementation(async () => ({} as never));
  await expect(f.handler(job, payload)).rejects.toThrow("不能记为成功");
});
it.each(["before_send", "after_output"] as const)("preserves gateway fee semantics for course drift %s without resending", async phase => {
  const f = fixture(), release = vi.fn(async () => {}), markUnknown = vi.fn(async () => {}), settle = vi.fn(async () => {});
  const provider = { complete: vi.fn(async () => ({ text: JSON.stringify({ problem: "求 $\\\\int x^3 dx$。", workedSolution: "$x^4/4+C$，求导核对。" }),
    inputTokens: 20, outputTokens: 40, citedChunkIds: [], candidates: [], requestId: null })) };
  if (phase === "before_send") f.repository.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("course rebound"));
  else f.repository.publish.mockRejectedValueOnce(new Error("course rebound"));
  const gateway = createModelGateway({ resolve: async () => ({ provider,
    modelSnapshot: { id: "synthetic", providerId: "synthetic", modelName: "synthetic", inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
    inputCentsPerMillion: 1, outputCentsPerMillion: 1 }) });
  const handler = createTeachingExampleHandler({ repository: f.repository, gateway, budget: () => ({
    reserve: async () => ({ id, state: "reserved" }), claimExecution: async () => true, release, markUnknown, settle,
  }) });
  await expect(handler(job, payload)).rejects.toThrow("course rebound");
  expect(provider.complete).toHaveBeenCalledTimes(phase === "before_send" ? 0 : 1);
  expect(release).toHaveBeenCalledTimes(phase === "before_send" ? 1 : 0);
  expect(markUnknown).toHaveBeenCalledTimes(phase === "after_output" ? 1 : 0);
  expect(settle).not.toHaveBeenCalled();
  f.repository.ledger.mockResolvedValue("unknown" as never);
  await expect(handler(job, payload)).rejects.toThrow("不会重发");
  expect(provider.complete).toHaveBeenCalledTimes(phase === "before_send" ? 0 : 1);
});
it("rejects legacy/mixed payloads and absent execution authority", async () => {
  const f = fixture(); await expect(f.handler(job, { ...payload, activityId: id })).rejects.toThrow();
  await expect(f.handler({ ...job, claimToken: undefined }, payload)).rejects.toThrow();
  expect(f.gateway.call).not.toHaveBeenCalled();
});
