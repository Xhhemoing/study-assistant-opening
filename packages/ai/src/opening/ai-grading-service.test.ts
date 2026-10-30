import { expect, it, vi } from "vitest";
import type { LearningObservation, ProviderOutput, Scope } from "@aistudy/contracts";
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
type Repository = OpeningAiGradingServiceDeps["repository"];
type Budget = ReturnType<OpeningAiGradingServiceDeps["budget"]>;

function setup() {
  const complete = vi.fn(async () => output);
  const model: ResolvedTaskModel = { provider: { complete }, inputCentsPerMillion: 20_000, outputCentsPerMillion: 20_000,
    modelSnapshot: { id: "changed", providerId: "fixture", modelName: "changed-model", inputCentsPerMillion: 20_000, outputCentsPerMillion: 20_000 } };
  let saved: LearningObservation | null = null;
  const repository = {
    context: vi.fn<Repository["context"]>(async () => ({ observation: original, stem: "1/2+1/2?", referenceText: "1", misconceptions: [],
      existing: saved, answerRevision: 1, operationId: base, workSource: null })),
    apply: vi.fn<Repository["apply"]>(async () => { saved = graded; return graded; }),
    ledger: vi.fn<Repository["ledger"]>(async () => "unsent"),
    releasedReservation: vi.fn<NonNullable<Repository["releasedReservation"]>>(async () => null),
  };
  const budget = { reserve: vi.fn<Budget["reserve"]>(async () => ({ id: "fresh", state: "reserved" })),
    claimExecution: vi.fn(async () => true), settle: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined), markUnknown: vi.fn(async () => undefined) };
  const gateway = createModelGateway({ resolve: async () => model });
  const service = createOpeningAiGradingService({ repository, gateway, budget: () => budget, images: async () => [] });
  return { repository, budget, complete, service, gateway };
}

it("grades the original work alongside pinned reference images with distinct roles and preserves correction metadata", async () => {
  const f = setup();
  const context = await f.repository.context(scope, input);
  const work = { id: "work", version: 2, physicalPage: 1 };
  const reference = { sourceId: "reference", sourceVersion: 3, physicalPage: 4 };
  const interpretation = { kind: "photo_transcription" as const, version: 1, workSource: work, originalTranscriptionObservationId: original.id,
    originalTranscription: "错误识别", correctedTranscription: "原稿内容", previousInterpretationObservationId: null, correctionReason: "漏识别" };
  f.repository.context.mockResolvedValue({ ...context, workSource: work, referenceSources: [reference], interpretation });
  const images = vi.fn<OpeningAiGradingServiceDeps["images"]>(async (_scope, request) => [{ sourceId: request.sourceIds[0]!, physicalPage: request.physicalPage,
    mediaType: "image/png", data: "data:image/png;base64,AA==" }]);
  const call = vi.fn<OpeningAiGradingServiceDeps["gateway"]["call"]>(async (_scope, _task, options) => { await options.persistResult!(output, { reservationId: "fresh", settledCents: 1 }); return output; });
  const service = createOpeningAiGradingService({ repository: f.repository, gateway: { call }, budget: () => f.budget, images });
  await service.grade(scope, input);
  expect(images).toHaveBeenCalledWith(scope, { sourceIds: ["reference"], sourceVersions: { reference: 3 }, physicalPage: 4 });
  const sent = call.mock.calls[0]![2].input;
  expect(JSON.parse(sent.text)).toMatchObject({ studentAnswer: original.answer, photoTranscriptionCorrection: interpretation, imageRoles: [
    { role: "student_work", sourceId: "work", physicalPage: 1 }, { role: "reference_material", sourceId: "reference", physicalPage: 4 },
  ] });
  expect(sent.imageParts).toHaveLength(2);
  expect(call.mock.calls[0]![1]).toBe("practice.grade-photo");
  expect(sent.instruction).toContain("不能先改正");
});

it("does not send or reserve when the required reference page cannot be read", async () => {
  const f = setup();
  f.repository.context.mockResolvedValue({ ...await f.repository.context(scope, input), referenceSources: [{ sourceId: "r", sourceVersion: 1, physicalPage: 3 }] });
  const service = createOpeningAiGradingService({ repository: f.repository, gateway: f.gateway, budget: () => f.budget, images: async () => [] });
  await expect(service.grade(scope, input)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(f.complete).not.toHaveBeenCalled(); expect(f.budget.reserve).not.toHaveBeenCalled();
});

it("rejects five distinct work/reference pages before loading or sending", async () => {
  const f = setup();
  f.repository.context.mockResolvedValue({ ...await f.repository.context(scope, input), workSource: { id: "w", version: 1, physicalPage: 1 },
    referenceSources: [1,2,3,4].map(physicalPage => ({ sourceId: "r", sourceVersion: 1, physicalPage })) });
  const images = vi.fn(async () => []);
  const service = createOpeningAiGradingService({ repository: f.repository, gateway: f.gateway, budget: () => f.budget, images });
  await expect(service.grade(scope, input)).rejects.toThrow("三");
  expect(images).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
});

it("grades one original work page together with three reference pages without dropping any image", async () => {
  const f = setup();
  f.repository.context.mockResolvedValue({ ...await f.repository.context(scope, input), workSource: { id: "work", version: 1, physicalPage: 1 },
    referenceSources: [1,2,3].map(physicalPage => ({ sourceId: "reference", sourceVersion: 1, physicalPage })) });
  const images = vi.fn<OpeningAiGradingServiceDeps["images"]>(async (_scope, request) => [{ sourceId: request.sourceIds[0]!, physicalPage: request.physicalPage,
    mediaType: "image/png", data: "data:image/png;base64,AA==" }]);
  const call = vi.fn<OpeningAiGradingServiceDeps["gateway"]["call"]>(async (_scope, _task, options) => { await options.persistResult!(output, { reservationId: "fresh", settledCents: 1 }); return output; });
  await createOpeningAiGradingService({ repository: f.repository, gateway: { call }, budget: () => f.budget, images }).grade(scope, input);
  expect(images).toHaveBeenCalledTimes(4);
  expect(call.mock.calls[0]![2].input.imageParts).toHaveLength(4);
  expect(JSON.parse(call.mock.calls[0]![2].input.text).imageRoles.map((image: { role: string }) => image.role)).toEqual(["student_work", "reference_material", "reference_material", "reference_material"]);
});

it("does not treat a reference image as a missing student answer", async () => {
  const f = setup();
  f.repository.context.mockResolvedValue({ ...await f.repository.context(scope, input), observation: { ...original, answer: "" },
    referenceSources: [{ sourceId: "reference", sourceVersion: 1, physicalPage: 1 }] });
  const images = vi.fn<OpeningAiGradingServiceDeps["images"]>(async () => [{ sourceId: "reference", physicalPage: 1, mediaType: "image/png", data: "data:image/png;base64,AA==" }]);
  const call = vi.fn<OpeningAiGradingServiceDeps["gateway"]["call"]>(async (_scope, _task, options) => { await options.persistResult!(output, { reservationId: "fresh", settledCents: 1 }); return output; });
  const service = createOpeningAiGradingService({ repository: f.repository, gateway: { call }, budget: () => f.budget, images });
  await expect(service.grade(scope, input)).rejects.toThrow("答案");
  expect(call).not.toHaveBeenCalled();
});

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

it.each([
  ["top-level feedback", { feedback: "结果含\u0000字符" }],
  ["nested proof step", { proofFeedback: { coverage: "partial", steps: [{ stepIndex: 1, claim: "x\u0000", required: true, verdict: "correct", feedback: "可见", repairPrompt: "核对" }] } }],
] as const)("converts model output with a real NUL in %s into durable unverified feedback", async (_name, field) => {
  const f = setup();
  const nulOutput = { ...proposal, ...field, followUp: { prompt: "不要保存", options: [{ id: "a", label: "1" }, { id: "b", label: "2" }], answerId: "a", explanation: "不要保存" }, transcription: "正常转录，不应保留" };
  f.complete.mockResolvedValue({ ...output, text: JSON.stringify(nulOutput) });
  const initialContext = await f.repository.context(scope, input);
  f.repository.apply.mockImplementation(async (_scope, _input, savedProposal) => {
    const saved = { ...original, id: graded.id, outcome: savedProposal.outcome, feedback: savedProposal.feedback };
    f.repository.context.mockResolvedValue({ ...initialContext, existing: saved });
    return saved;
  });
  const result = await f.service.grade(scope, input);
  expect(result).toMatchObject({ outcome: "unverified", answer: original.answer });
  expect(f.repository.apply).toHaveBeenCalledTimes(1);
  expect(f.repository.apply.mock.calls[0]![1]).toEqual(input);
  const context = await f.repository.context(scope, input);
  expect(context.observation.answer).toBe(original.answer);
  const savedProposal = f.repository.apply.mock.calls[0]![2];
  expect(savedProposal).toMatchObject({ outcome: "unverified", confidence: 0, questionMatch: false,
    feedback: "批改输出包含无法保存的字符，本次无法可靠判定；原答案已保存，请核对后手动改评。",
    criteria: [{ verdict: "unverified" }], misconceptionId: null });
  expect(savedProposal.feedback).not.toContain("\u0000");
  expect(savedProposal.criteria).toEqual([{ label: "批改输出", verdict: "unverified", feedback: savedProposal.feedback }]);
  expect(savedProposal.followUp).toBeUndefined();
  expect(savedProposal.proofFeedback).toBeUndefined();
  expect(savedProposal.transcription).toBeUndefined();
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.budget.settle).toHaveBeenCalledExactlyOnceWith("fresh", 1, { resultRef: `ai-grade:${input.observationId}` });
  expect(f.budget.markUnknown).not.toHaveBeenCalled();
  expect(await f.service.grade(scope, input)).toBe(result);
  expect(f.repository.apply).toHaveBeenCalledTimes(1);
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.budget.reserve).toHaveBeenCalledTimes(1);
  expect(f.budget.settle).toHaveBeenCalledTimes(1);
  expect(f.budget.markUnknown).not.toHaveBeenCalled();
});

it("does not mistake a literal backslash-u0000 or safe text for a broken proposal", async () => {
  const f = setup();
  const safe = { ...proposal, feedback: "字面量 \\u0000 与中文\n数学 $x^2$" };
  f.complete.mockResolvedValue({ ...output, text: JSON.stringify(safe) });
  await f.service.grade(scope, input);
  expect(f.repository.apply.mock.calls[0]![2]).toEqual(safe);
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.budget.settle).toHaveBeenCalledTimes(1);
  expect(f.budget.markUnknown).not.toHaveBeenCalled();
});
