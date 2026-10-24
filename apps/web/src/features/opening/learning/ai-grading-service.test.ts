import { beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetReplayError, OpeningModelRoutingError, type ModelGateway } from "@aistudy/ai";
import type { AiGradingProposal, LearningObservation, Scope } from "@aistudy/contracts";
import { createOpeningAiGradingService } from "./ai-grading-service";
import { rankPedagogy } from "../../../../../../tests/fixtures/opening/teaching/rank-pedagogy";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope: Scope = { workspaceId: id(1), ownerUserId: id(2) };
const input = { observationId: id(3) };
const proposal: AiGradingProposal = { outcome: "correct", confidence: 0.91, questionMatch: true,
  feedback: "两个系数与第三个分量都满足条件。", criteria: [{ label: "分量核对", verdict: "correct", feedback: "2v+3w=(2,3,5)" }] };
const original = { id: id(3), answer: "u=2v+3w", outcome: "unverified", verdictSource: "self_report" } as LearningObservation;
const graded = { ...original, id: id(4), verdictSource: "ai_graded", outcome: "correct" } as LearningObservation;
type Options = Parameters<ModelGateway["call"]>[2];
const output = { text: JSON.stringify(proposal), inputTokens: 100, outputTokens: 120 };

function setup() {
  const context = { observation: original, stem: "v=(1,0,1), w=(0,1,1), u=(2,3,5)，u是否在span{v,w}中？",
    referenceText: "u属于span{v,w}当且仅当存在系数使u=av+bw。", sourceIds: [id(5)], sourceVersions: { [id(5)]: 1 },
    answerRevision: 1, operationId: `ai-grade:${scope.workspaceId}:${input.observationId}`,
    workSource: null as { id: string; version: number; physicalPage: number } | null, existing: null as LearningObservation | null };
  const repository = { context: vi.fn(async () => context), apply: vi.fn(async () => { context.existing = graded; return graded; }),
    ledger: vi.fn(async (): Promise<"unsent" | "unknown" | "completed" | "blocked"> => "unsent") };
  const images = vi.fn(async () => [{ sourceId: id(6), physicalPage: 1, mediaType: "image/png" as const, data: "data:image/png;base64,AAAA" }]);
  const call = vi.fn(async (_scope: Scope, _task: string, options: Options) => {
    await options.beforeSend?.();
    options.onModel?.({ modelSnapshot: { modelName: "test-grader" } } as never, { fallback: false });
    await options.persistResult?.(output, { reservationId: "reservation", settledCents: 1 });
    return output;
  });
  const service = createOpeningAiGradingService({ repository: repository as never, gateway: { call }, images, budget: () => ({} as Options["budget"]) });
  return { service, context, repository, images, call };
}

describe("saved answer AI grading", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("grades the server's saved question and answer through the budget gateway and persists before returning", async () => {
    const { service, repository, call, images, context } = setup();
    expect(await service.grade(scope, input)).toBe(graded);
    const options = call.mock.calls[0]![2];
    expect(call.mock.calls[0]!.slice(0, 2)).toEqual([scope, "practice.grade-text"]);
    expect(options.operationId).toBe(`ai-grade:${scope.workspaceId}:${input.observationId}`);
    expect(JSON.parse(options.input.text)).toEqual({ question: context.stem, studentAnswer: original.answer, reference: context.referenceText });
    expect(options.input.mediaCapability).toBe("text_only");
    expect(repository.context).toHaveBeenCalledTimes(2);
    expect(repository.apply).toHaveBeenCalledWith(scope, input, proposal, "test-grader");
    expect(images).not.toHaveBeenCalled();
    expect(original.answer).toBe("u=2v+3w");
  });

  it("passes only the repository's misconception dictionary into the grader", async () => {
    const { service, context, call } = setup();
    Object.assign(context, { misconceptions: rankPedagogy.misconceptions });
    await service.grade(scope, input);
    expect(JSON.parse(call.mock.calls[0]![2].input.text).misconceptions).toEqual(rankPedagogy.misconceptions);
  });

  it("uses the captured image version with vision routing, keeping the original text", async () => {
    const { service, context, images, call } = setup();
    context.workSource = { id: id(6), version: 2, physicalPage: 1 };
    const photo = { ...input, workSourceId: id(6), workSourceVersion: 2, physicalPage: 1 };
    await service.grade(scope, photo);
    expect(images).toHaveBeenCalledWith(scope, { sourceIds: [id(6)], sourceVersions: { [id(6)]: 2 }, physicalPage: 1 });
    expect(call.mock.calls[0]![1]).toBe("practice.grade-photo");
    expect(call.mock.calls[0]![2].input.imageParts).toHaveLength(1);
    expect(JSON.parse(call.mock.calls[0]![2].input.text).studentAnswer).toBe(original.answer);
  });

  it("returns an already saved result without another model request", async () => {
    const { service, context, call, images } = setup();
    context.existing = graded;
    expect(await service.grade(scope, input)).toBe(graded);
    expect(call).not.toHaveBeenCalled(); expect(images).not.toHaveBeenCalled();
  });

  it("rejects client verdicts and incomplete photo identity before reading or sending", async () => {
    const { service, repository, call } = setup();
    await expect(service.grade(scope, { ...input, outcome: "correct" })).rejects.toThrow();
    await expect(service.grade(scope, { ...input, workSourceId: id(6) })).rejects.toThrow();
    expect(repository.context).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
  });

  it("does not call a model for missing images or an empty answer", async () => {
    const { service, context, images, call } = setup();
    context.workSource = { id: id(6), version: 2, physicalPage: 1 };
    images.mockResolvedValue([]);
    await expect(service.grade(scope, { ...input, workSourceId: id(6), workSourceVersion: 2, physicalPage: 1 })).rejects.toThrow("无法读取作答照片");
    context.workSource = null; context.observation = { ...original, answer: " " };
    await expect(service.grade(scope, input)).rejects.toThrow("先填写答案");
    expect(call).not.toHaveBeenCalled();
  });

  it("rechecks access before sending and preserves a user's concurrent correction", async () => {
    const { service, repository } = setup();
    repository.context.mockRejectedValueOnce(Object.assign(new Error("记录已更正"), { code: "CONFLICT" }));
    await expect(service.grade(scope, input)).rejects.toThrow("记录已更正");
    expect(repository.apply).not.toHaveBeenCalled();
    repository.apply.mockRejectedValueOnce(Object.assign(new Error("记录已更正"), { code: "CONFLICT" }));
    await expect(service.grade(scope, input)).rejects.toThrow("记录已更正");
  });

  it.each(["not json", JSON.stringify({ ...proposal, confidence: 1.2 }), JSON.stringify({ ...proposal, criteria: [] })])(
    "does not turn malformed model output into a grade (%s)", async text => {
      const { service, repository, call } = setup();
      call.mockImplementation(async (_scope, _task, options) => {
        await options.persistResult?.({ ...output, text }, { reservationId: "reservation", settledCents: 1 });
        return output;
      });
      await expect(service.grade(scope, input)).rejects.toThrow("未返回完整的评分结果");
      expect(repository.apply).not.toHaveBeenCalled();
    });

  it("keeps a successfully committed grade when ledger settlement fails afterwards", async () => {
    const { service, call } = setup();
    call.mockImplementation(async (_scope, _task, options) => {
      await options.persistResult?.(output, { reservationId: "reservation", settledCents: 1 });
      throw new Error("settlement unavailable");
    });
    expect(await service.grade(scope, input)).toBe(graded);
  });

  it.each(["in_flight", "unknown"] as const)("does not resend a %s paid operation", async kind => {
    const { service, call, repository } = setup();
    call.mockRejectedValue(new BudgetReplayError(kind === "in_flight"
      ? { kind, reservationId: "reservation" } : { kind, reservationId: "reservation", pendingReconcileCents: 0, reconciled: false }));
    await expect(service.grade(scope, input)).rejects.toMatchObject({ code: "GRADING_UNKNOWN_COST" });
    expect(call).toHaveBeenCalledTimes(1); expect(repository.apply).not.toHaveBeenCalled();
  });

  it("permits an explicit retry after ledger-confirmed not-sent failures, using a shared deterministic retry key", async () => {
    const { service, call } = setup();
    call.mockRejectedValueOnce(new BudgetReplayError({ kind: "released", reservationId: "first", reason: "not_sent" }));
    call.mockRejectedValueOnce(new BudgetReplayError({ kind: "released", reservationId: "second", reason: "not_sent" }));
    expect(await service.grade(scope, input)).toBe(graded);
    const base = `ai-grade:${scope.workspaceId}:${input.observationId}`;
    expect(call.mock.calls.map(args => args[2].operationId)).toEqual([base, `${base}:retry:first`, `${base}:retry:second`]);
  });

  it("stops at an unknown retry and does not create another paid request", async () => {
    const { service, call } = setup();
    call.mockRejectedValueOnce(new BudgetReplayError({ kind: "released", reservationId: "first", reason: "not_sent" }));
    call.mockRejectedValueOnce(new BudgetReplayError({ kind: "unknown", reservationId: "second", pendingReconcileCents: 0, reconciled: false }));
    await expect(service.grade(scope, input)).rejects.toMatchObject({ code: "GRADING_UNKNOWN_COST" });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("does not reissue legacy releases without a known not-sent reason", async () => {
    const { service, call } = setup();
    call.mockRejectedValueOnce(new BudgetReplayError({ kind: "released", reservationId: "first", reason: null }));
    await expect(service.grade(scope, input)).rejects.toThrow("尚未完成");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("gives an actionable configuration error and never exposes upstream details", async () => {
    const { service, call } = setup();
    call.mockRejectedValueOnce(new OpeningModelRoutingError("missing model"));
    await expect(service.grade(scope, input)).rejects.toThrow("设置中配置可用的批改模型");
    call.mockRejectedValueOnce(new Error("secret upstream endpoint and token"));
    await expect(service.grade(scope, input)).rejects.toThrow("AI 批改暂时未完成");
  });

  it("uses the sealed revision operation key rather than inventing a new worker key", async () => {
    const { service, context, call } = setup();
    context.operationId = `ai-grade:${scope.workspaceId}:${id(7)}:3`;
    await service.grade(scope, input);
    expect(call.mock.calls[0]![2].operationId).toBe(context.operationId);
  });

  it.each(["unknown", "completed", "blocked"] as const)("reads the existing ledger family without invoking the gateway for %s", async ledger => {
    const { service, call, repository } = setup();
    repository.ledger.mockResolvedValue(ledger);
    await expect(service.grade(scope, input)).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
    expect(repository.apply).not.toHaveBeenCalled();
  });

  it("will not bypass a previously unknown fallback after a primary not-sent release", async () => {
    const { service, call, repository } = setup();
    repository.ledger.mockResolvedValueOnce("unsent").mockResolvedValue("unknown");
    call.mockRejectedValueOnce(new BudgetReplayError({ kind: "released", reservationId: "primary", reason: "not_sent" }));
    await expect(service.grade(scope, input)).rejects.toMatchObject({ code: "GRADING_UNKNOWN_COST" });
    expect(call).toHaveBeenCalledTimes(1);
  });
});
