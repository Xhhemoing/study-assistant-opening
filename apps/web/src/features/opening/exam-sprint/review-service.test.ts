import { beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetReplayError, type ModelGateway } from "@aistudy/ai";
import type { ExamWorkReview, ExamWorkReviewInput, ProviderInput, Scope } from "@aistudy/contracts";
import { createExamPhotoReviewService } from "./review-service";

const scope: Scope = { workspaceId: "workspace", ownerUserId: "owner" };
const input: ExamWorkReviewInput = { clientKey: "review-key-1", sourceItemId: "paper-q1", workSourceId: "work",
  workSourceVersion: 0, referenceSourceId: "reference", referenceSourceVersion: 1, answerText: "my answer" };
const proposal = { transcription: "x=2", questionMatch: true, outcome: "correct" as const,
  steps: [{ label: "代入", verdict: "correct" as const, feedback: "符合条件" }], summary: "请复核题意和过程", errorCause: null };
type Options = Parameters<ModelGateway["call"]>[2];
let stored: ExamWorkReview;
const repository = {
  begin: vi.fn(), read: vi.fn(), assertCurrent: vi.fn(), complete: vi.fn(), fail: vi.fn(),
};
const call = vi.fn(), images = vi.fn();
const service = createExamPhotoReviewService({ repository, gateway: { call }, images, budget: () => ({} as Options["budget"]) });
const output = { text: JSON.stringify(proposal), inputTokens: 10, outputTokens: 20, citedChunkIds: [], requestId: "review-test", candidates: [] };

describe("exam photo review is a durable proposal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stored = { id: "review-1", sourceItemId: input.sourceItemId, workSourceId: "work", referenceSourceId: "reference",
      workSourceVersion: 0, referenceSourceVersion: 1, answerText: input.answerText,
      status: "pending", proposal: null, modelLabel: null, createdAt: "2026-10-17T00:00:00Z" };
    repository.begin.mockImplementation(async () => ({ review: { ...stored }, input, privacyEpoch: 2, referencePage: 3, questionLabel: "题1" }));
    repository.read.mockImplementation(async () => stored);
    repository.complete.mockImplementation(async (_scope, _id, value, modelLabel) => { stored = { ...stored, status: "ready", proposal: value, modelLabel }; });
    repository.fail.mockImplementation(async (_scope, _id, status) => { if (stored.status !== "ready") stored.status = status; });
    images.mockResolvedValue([{ mediaType: "image/png", data: "data:image/png;base64,AAAA" }] satisfies ProviderInput["imageParts"]);
    call.mockImplementation(async (_scope, _task, options: Options) => { await options.beforeSend?.(); await options.persistResult?.(output, { reservationId: "r", settledCents: 1 }); return output; });
  });
  it("uses the shared vision gateway, fixed operation id and persistence before returning", async () => {
    expect((await service.review(scope, input)).proposal).toEqual(proposal);
    const options = call.mock.calls[0]![2] as Options;
    expect(call.mock.calls[0]!.slice(0, 2)).toEqual([scope, "practice.grade-photo"]);
    expect(options.operationId).toBe("exam-review:workspace:review-1");
    expect(options.input.imageParts).toHaveLength(2);
    expect(images.mock.calls.map(args => args[1].physicalPage)).toEqual([1, 3]);
    expect(repository.assertCurrent).toHaveBeenCalledWith(scope, "review-1");
    expect(repository.complete).toHaveBeenCalledTimes(1);
  });
  it.each(["ready", "unknown", "failed"] as const)("does not resend a %s logical operation", async status => {
    stored.status = status;
    await service.review(scope, input);
    expect(call).not.toHaveBeenCalled();
    expect(images).not.toHaveBeenCalled();
  });
  it("abstains when the model cannot match the question", async () => {
    call.mockImplementation(async (_scope, _task, options: Options) => {
      await options.beforeSend?.();
      await options.persistResult?.({ ...output, text: JSON.stringify({ ...proposal, questionMatch: false }) }, { reservationId: "r", settledCents: 1 });
      return output;
    });
    expect((await service.review(scope, input)).proposal?.outcome).toBe("unverified");
  });
  it("preserves in-flight recovery and records unknown after a sent invalid response", async () => {
    call.mockRejectedValueOnce(new BudgetReplayError({ kind: "in_flight", reservationId: "r" }));
    expect((await service.review(scope, input)).status).toBe("pending");
    expect(repository.fail).not.toHaveBeenCalled();
    call.mockImplementation(async (_scope, _task, options: Options) => { await options.beforeSend?.(); throw new Error("timeout"); });
    expect((await service.review(scope, input)).status).toBe("unknown");
  });
  it("does not send without both actual images or after a privacy guard failure", async () => {
    images.mockResolvedValueOnce([]);
    expect((await service.review(scope, input)).status).toBe("failed");
    expect(call).not.toHaveBeenCalled();
    stored.status = "pending";
    repository.assertCurrent.mockRejectedValueOnce(new Error("privacy changed"));
    expect((await service.review(scope, input)).status).toBe("failed");
    expect(repository.complete).not.toHaveBeenCalled();
  });
  it("keeps sent non-JSON output and a failed persistence/privacy check unknown", async () => {
    call.mockImplementationOnce(async (_scope, _task, options: Options) => {
      await options.beforeSend?.();
      await options.persistResult?.({ ...output, text: "not json" }, { reservationId: "r", settledCents: 1 });
      return output;
    });
    expect((await service.review(scope, input)).status).toBe("unknown");
    expect(repository.complete).not.toHaveBeenCalled();
    stored.status = "pending";
    repository.complete.mockRejectedValueOnce(new Error("source was excluded after send"));
    expect((await service.review(scope, input)).status).toBe("unknown");
    expect(stored.proposal).toBeNull();
  });
  it("does not reinterpret a previous unknown send as a not-sent failure", async () => {
    call.mockRejectedValue(new BudgetReplayError({ kind: "unknown", reservationId: "r", pendingReconcileCents: 0, reconciled: false }));
    expect((await service.review(scope, input)).status).toBe("unknown");
    expect(repository.assertCurrent).not.toHaveBeenCalled();
  });
});
