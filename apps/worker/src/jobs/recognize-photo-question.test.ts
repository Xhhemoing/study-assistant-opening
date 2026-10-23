import { expect, it, vi } from "vitest";
import { BudgetReplayError, type ModelGateway } from "@aistudy/ai";
import type { OpeningJobRecord } from "@aistudy/database";
import { createRecognizePhotoQuestionHandler } from "./recognize-photo-question";
const id = "11111111-1111-4111-8111-111111111111";
const input = { sourceId: id, sourceVersion: 0 };
const job = { id, workspaceId: id, ownerUserId: id, key: "recognize", kind: "recognize-photo-question", payload: input, result: null, state: "running", privacyEpoch: 0, claimToken: id } satisfies OpeningJobRecord;
const proposal = { stem: "计算【待核对】+1", uncertainFragments: [{ fragment: "【待核对】", reason: "数字模糊" }] };
type Options = Parameters<ModelGateway["call"]>[2];
function setup() {
  const repository = { assertCurrent: vi.fn().mockResolvedValue(undefined), complete: vi.fn().mockResolvedValue(undefined) };
  const images = vi.fn().mockResolvedValue([{ sourceId: id, physicalPage: 1, mediaType: "image/png", data: "data:image/png;base64,AAAA" }]);
  const output = { text: JSON.stringify(proposal), inputTokens: 10, outputTokens: 30 };
  const call = vi.fn(async (_scope: unknown, _task: unknown, options: Options) => { await options.beforeSend?.(); await options.persistResult?.(output, { reservationId: id, settledCents: 1 }); return output; });
  const handler = createRecognizePhotoQuestionHandler({ repository, images, gateway: { call }, budget: () => ({} as Options["budget"]) });
  return { repository, images, call, handler, output };
}
it("uses the exact source version and vision route, rechecks before send and persists only a transcription candidate", async () => {
  const { handler, repository, images, call } = setup();
  expect(await handler(job, input)).toEqual(proposal);
  expect(images).toHaveBeenCalledWith(expect.objectContaining({ jobExecution: { id, token: id, privacyEpoch: 0 } }), { sourceIds: [id], sourceVersions: { [id]: 0 }, physicalPage: 1 });
  expect(repository.assertCurrent).toHaveBeenCalledTimes(2);
  expect(repository.complete).toHaveBeenCalledWith(expect.anything(), input, proposal);
  expect(call.mock.calls[0]?.[1]).toBe("practice.recognize-photo");
  expect(call.mock.calls[0]?.[2]).toMatchObject({ operationId: `recognize-photo-question:${id}:${id}`, resultRef: `opening-job:${id}`, input: { outputFormat: "json", mediaCapability: "text_plus_page_images" } });
  expect(call.mock.calls[0]?.[2].input.instruction).toContain("不解题");
});
it("retains a persisted transcription when settlement fails instead of inviting another provider call", async () => {
  const { handler, call, output, repository } = setup();
  call.mockImplementation(async (_scope, _task, options) => { await options.beforeSend?.(); await options.persistResult?.(output, { reservationId: id, settledCents: 1 }); throw new Error("settlement interrupted"); });
  expect(await handler(job, input)).toEqual(proposal);
  expect(repository.complete).toHaveBeenCalledOnce(); expect(call).toHaveBeenCalledOnce();
});
it.each(["unknown", "in_flight"] as const)("never retries a %s budget outcome", async kind => {
  const { handler, call, repository } = setup();
  const failure = new BudgetReplayError(kind === "unknown" ? { kind, reservationId: id, pendingReconcileCents: 1, reconciled: false } : { kind, reservationId: id });
  call.mockRejectedValue(failure);
  await expect(handler(job, input)).rejects.toBe(failure);
  expect(call).toHaveBeenCalledOnce(); expect(repository.complete).not.toHaveBeenCalled();
});
it("refuses a changed source before image/model access", async () => {
  const { handler, repository, images, call } = setup(); repository.assertCurrent.mockRejectedValue(new Error("source changed"));
  await expect(handler(job, input)).rejects.toThrow("source changed");
  expect(images).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
});
it("rejects model answer fields without publishing a false recognition result", async () => {
  const { handler, call, repository } = setup();
  call.mockImplementation(async (_scope, _task, options) => { await options.persistResult?.({ text: JSON.stringify({ ...proposal, answer: "2" }), inputTokens: 10, outputTokens: 20 }, { reservationId: id, settledCents: 1 }); return { text: "unused", inputTokens: 10, outputTokens: 20 }; });
  await expect(handler(job, input)).rejects.toThrow(); expect(repository.complete).not.toHaveBeenCalled();
});
