import { expect, it, vi } from "vitest";
import { OpeningProviderError } from "@aistudy/ai";
import type { ProviderOutput, StudyContextAnchor, StudyExposureReceipt } from "@aistudy/contracts";
import { createEphemeralTutorService, type EphemeralProvider } from "./ephemeral-service";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) };
const anchor: StudyContextAnchor = { courseId: id(3), attemptId: id(4), purpose: "learning_help" };
const output: ProviderOutput = { text: "先列方程。", citedChunkIds: [], candidates: [], requestId: "provider", inputTokens: 10, outputTokens: 5 };
const input = { text: "给一点提示", sourceIds: [], mode: "hint" as const, history: [], contextAnchor: anchor };

function fixture(complete: EphemeralProvider["complete"]) {
  const state = { epoch: 1 };
  const delivery = vi.fn(async () => ({ id: id(5), contextAnchor: anchor } as StudyExposureReceipt));
  const budget = { reserve: vi.fn(async () => ({ id: "reservation" })), claimExecution: async () => true,
    settle: vi.fn(async () => {}), release: vi.fn(async () => {}), markUnknown: vi.fn(async () => {}) };
  const service = createEphemeralTutorService({
    provider: { complete }, budget, sources: { listOwnedIds: async () => [] }, chunks: { listForSources: async () => [] },
    privacy: { snapshot: async () => ({ epoch: state.epoch, excludedSourceIds: [] }), currentEpoch: async () => state.epoch },
    studyContext: { resolve: async () => anchor }, exposures: { deliver: delivery }, requestKey: () => "stream-test",
    config: { maxContextCharacters: 12000, maxOutputTokens: 500, reservedCents: 10, inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
  });
  return { service, delivery, budget, state };
}

it("emits real Markdown before completion, recording help before the first displayed token only once", async () => {
  const order: string[] = [];
  const f = fixture(async (sent, _signal, emit) => {
    expect(sent.outputFormat).toBe("markdown");
    await emit?.("先列"); order.push("provider-midway");
    await emit?.("方程。"); return output;
  });
  f.delivery.mockImplementation(async () => { order.push("help-recorded"); return { id: id(5), contextAnchor: anchor } as StudyExposureReceipt; });
  const reply = await f.service.replyEphemeral(scope, input, undefined, delta => { order.push(delta); });
  expect(order).toEqual(["help-recorded", "先列", "provider-midway", "方程。"]);
  expect(f.delivery).toHaveBeenCalledOnce();
  expect(reply).toMatchObject({ text: output.text, exposureReceipt: { id: id(5) }, candidates: [] });
  expect(f.budget.settle).toHaveBeenCalledOnce();
});

it("retains already delivered help when a partially displayed answer subsequently fails", async () => {
  const f = fixture(async (_input, _signal, emit) => {
    await emit?.("先列方程"); throw new OpeningProviderError("PROVIDER_TIMEOUT", "timed out", true, true);
  });
  const displayed: string[] = [];
  await expect(f.service.replyEphemeral(scope, input, undefined, delta => { displayed.push(delta); })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  expect(displayed).toEqual(["先列方程"]);
  expect(f.delivery).toHaveBeenCalledOnce();
  expect(f.budget.markUnknown).toHaveBeenCalledWith("reservation");
  expect(f.budget.release).not.toHaveBeenCalled();
});

it("stops delivery if privacy changes after one delta", async () => {
  const f = fixture(async (_input, _signal, emit) => {
    await emit?.("已允许的内容"); f.state.epoch++;
    await emit?.("不应显示"); return output;
  });
  const displayed: string[] = [];
  await expect(f.service.replyEphemeral(scope, input, undefined, delta => { displayed.push(delta); })).rejects.toMatchObject({ code: "PRIVACY_CHANGED" });
  expect(displayed).toEqual(["已允许的内容"]);
  expect(f.delivery).toHaveBeenCalledOnce();
  expect(f.budget.markUnknown).toHaveBeenCalledWith("reservation");
});
