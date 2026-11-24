import {
  ANTI_PADDING_COUNTERFACTUAL_TRIPLETS, SENTINEL_ANCHOR_ESSAYS, createModelGateway, createOpeningAiGradingService,
  evaluateCalibratedSubjectiveGrading, evaluateRubricCalibrationGate, getSentinelAnchorsForDimension,
  type OpeningAiGradingServiceDeps, type OpeningMultimodalEvidenceHook, type OpeningRubricCalibrationHook, type PairwiseSwapComparison,
  type RubricCalibrationPoint, type RubricSubmissionInput,
} from "@aistudy/ai";
import type { AiGradingProposal, LearningObservation, ProviderOutput, Scope } from "@aistudy/contracts";
import { describe, expect, it, vi } from "vitest";

const dimension = "task_response";
const comparisons = getSentinelAnchorsForDimension(dimension).map((anchor): PairwiseSwapComparison => {
  if (anchor.band < 6) return { anchorId: anchor.anchorId, forwardChoice: "A", reverseChoice: "B" };
  if (anchor.band > 6) return { anchorId: anchor.anchorId, forwardChoice: "B", reverseChoice: "A" };
  return { anchorId: anchor.anchorId, forwardChoice: "tie", reverseChoice: "tie" };
});
const proposal: AiGradingProposal = {
  outcome: "correct", confidence: 0.95, questionMatch: true, feedback: "The main argument is clear.",
  criteria: [{ label: "Argument", verdict: "correct", feedback: "The claim is supported by evidence." }],
};
const submission: RubricSubmissionInput = {
  submissionId: "draft", dimension, comparisons, text: SENTINEL_ANCHOR_ESSAYS[2]!.text,
  mode: "formal_assessment", assisted: false, corroboratingIndependentSubmissionIds: ["prior-draft"],
};
const point = (band: number, countsTowardMastery = true): RubricCalibrationPoint => ({
  status: "calibrated", band, rawBand: band, countsTowardMastery,
});
const gate = {
  benchmarkItems: [4, 5, 6, 6, 7, 7, 8, 9].map((band, index) => ({
    itemId: `gold-${index}`, trueBand: band, evaluation: point(band),
  })),
  counterfactualTriplets: [{
    tripletId: "counterfactual", substantiveConcise: point(6), templatePaddedExpansion: point(6, false),
    equalLengthSubstantive: point(7.5),
  }],
};

describe("Opening anchor-calibrated grading", () => {
  it("preserves a verified proposal when the submission and all calibration checks pass", () => {
    const result = evaluateCalibratedSubjectiveGrading({ proposal, submission, calibration: gate });
    expect(result.proposal).toEqual(proposal);
    expect(result.masteryEligible).toBe(true);
    expect(result.rubricResult).toMatchObject({ countsTowardMastery: true, status: "calibrated" });
    expect(result.gateReport).toMatchObject({ passed: true, metrics: { qwk: 1, adjacentAgreement: 1 } });
  });

  it.each([
    [{ comparisons: [{ ...comparisons[0]!, reverseChoice: comparisons[0]!.forwardChoice }, ...comparisons.slice(1)] }, "swap_position_bias_first"],
    [{ text: ANTI_PADDING_COUNTERFACTUAL_TRIPLETS[0]!.templatePaddedExpansion }, "template_padding_detected"],
    [{ corroboratingIndependentSubmissionIds: [] }, "single_draft_uncorroborated"],
    [{ mode: "practice_feedback" }, "practice_feedback_only"],
  ] satisfies Array<[Partial<RubricSubmissionInput>, string]>)("retains feedback when mastery fails", (change, reason) => {
    const result = evaluateCalibratedSubjectiveGrading({ proposal, submission: { ...submission, ...change }, calibration: gate });
    expect(result.proposal).toEqual({ ...proposal, outcome: "unverified" });
    expect([...result.rubricResult!.inconsistencyReasons, ...result.rubricResult!.masteryExclusionReasons]).toContain(reason);
  });

  it.each(["", " \n\t "])("leaves missing or blank text unverified before comparing anchors", text => {
    const result = evaluateCalibratedSubjectiveGrading({ proposal, submission: { ...submission, text }, calibration: gate });
    expect(result).toMatchObject({ masteryEligible: false, rubricResult: null, gateReport: { passed: true } });
    expect(result.proposal).toEqual({ ...proposal, outcome: "unverified" });
  });

  it("requires adjacent agreement even when QWK and the other gate metrics pass", () => {
    const predicted = [4, 5, 5, 7, 6, 8, 8, 9];
    const calibration = { ...gate, benchmarkItems: gate.benchmarkItems.map((item, index) => ({
      ...item, evaluation: point(predicted[index]!),
    })) };
    expect(evaluateRubricCalibrationGate(calibration)).toMatchObject({ passed: true });
    const result = evaluateCalibratedSubjectiveGrading({ proposal, submission, calibration });
    expect(result.gateReport).toMatchObject({ passed: false, metrics: { adjacentAgreement: 0.5 } });
    expect(result.gateReport.failures).toContain("adjacent_agreement_below_threshold");
    expect(result.proposal.outcome).toBe("unverified");
  });

  it.each([null, { ...gate, counterfactualTriplets: [] }, {
    ...gate, counterfactualTriplets: [{
      ...gate.counterfactualTriplets[0]!, templatePaddedExpansion: point(6.5, true),
    }],
  }])("requires an independently passing anti-padding gate", (calibration) => {
    const result = evaluateCalibratedSubjectiveGrading({ proposal, submission, calibration });
    expect(result.rubricResult?.countsTowardMastery).toBe(true);
    expect(result.gateReport.passed).toBe(false);
    expect(result.proposal).toEqual({ ...proposal, outcome: "unverified" });
  });
});

const scope: Scope = { workspaceId: "00000000-0000-4000-8000-000000000001", ownerUserId: "00000000-0000-4000-8000-000000000002" };
const textInput = { observationId: "00000000-0000-4000-8000-000000000003" };
const photo = { id: "00000000-0000-4000-8000-000000000004", version: 2, physicalPage: 1 };
const photoInput = { ...textInput, workSourceId: photo.id, workSourceVersion: photo.version, physicalPage: photo.physicalPage };

function gradingFixture(options: {
  answer?: string; attachedPhoto?: boolean; photoStorageKey?: string; rubricCalibration?: OpeningRubricCalibrationHook;
  multimodalEvidence?: OpeningMultimodalEvidenceHook;
} = {}) {
  const original = {
    id: textInput.observationId, answer: options.answer ?? submission.text, outcome: "unverified",
    ...(options.photoStorageKey ? { photoStorageKey: options.photoStorageKey } : {}),
  } as LearningObservation;
  const output: ProviderOutput = {
    text: JSON.stringify(proposal), inputTokens: 1, outputTokens: 1, citedChunkIds: [], candidates: [], requestId: null,
  };
  const complete = vi.fn(async () => output);
  const gateway = createModelGateway({ resolve: async () => ({ provider: { complete }, inputCentsPerMillion: 1,
    outputCentsPerMillion: 1, modelSnapshot: {
      id: "model", providerId: "fixture", modelName: "fixture", inputCentsPerMillion: 1, outputCentsPerMillion: 1,
      mediaInputTokenUpperBound: 8000, mediaMaxInputBytes: 1024, mediaInputCentsPerMillion: 2,
    } }) });
  let saved: LearningObservation | null = null;
  const apply = vi.fn<OpeningAiGradingServiceDeps["repository"]["apply"]>(async (_scope, _input, assessed) =>
    (saved = { ...original, outcome: assessed.outcome }));
  const reserve = vi.fn(async () => ({ id: "reserved", state: "reserved" as const }));
  const settle = vi.fn(async () => undefined);
  const service = createOpeningAiGradingService({
    repository: {
      context: async () => ({ observation: original, existing: saved, stem: "Essay prompt", referenceText: "", misconceptions: [],
        workSource: options.attachedPhoto ? photo : null, answerRevision: 1, operationId: "fixture-grading" }),
      apply, ledger: async () => "unsent",
    },
    gateway, budget: () => ({ reserve, settle, claimExecution: async () => true, release: async () => undefined, markUnknown: async () => undefined }),
    images: async () => [{ sourceId: photo.id, physicalPage: photo.physicalPage,
      mediaType: "image/png", data: "data:image/png;base64,AA==" }],
    ...(options.rubricCalibration ? { rubricCalibration: options.rubricCalibration } : {}),
    multimodalEvidence: options.multimodalEvidence,
  });
  return { service, original, complete, apply, reserve, settle, savedResult: () => saved };
}

const gradingScenarios = ["legacy", "objective", "uncalibrated", "padded", "verified"] as const;
it.each(gradingScenarios)("applies the rubric policy before persistence and reuses the saved result (%s)", async scenario => {
  const answer = scenario === "padded" ? ANTI_PADDING_COUNTERFACTUAL_TRIPLETS[0]!.templatePaddedExpansion : submission.text;
  const rubricCalibration = vi.fn(async () => scenario === "objective" ? null
    : { submission, calibration: scenario === "uncalibrated" ? null : gate });
  const { service, original, complete, apply, reserve, settle, savedResult } = gradingFixture({
    answer, rubricCalibration: scenario === "legacy" ? undefined : rubricCalibration,
  });
  const assessed = { ...proposal, outcome: scenario === "uncalibrated" || scenario === "padded" ? "unverified" : "correct" };
  await expect(service.grade(scope, textInput)).resolves.toMatchObject({ outcome: assessed.outcome });
  expect(apply).toHaveBeenCalledExactlyOnceWith(scope, textInput, assessed, "fixture");
  await expect(service.grade(scope, textInput)).resolves.toBe(savedResult());
  expect(complete).toHaveBeenCalledTimes(1);
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(settle).toHaveBeenCalledTimes(1);
  if (scenario === "legacy") expect(rubricCalibration).not.toHaveBeenCalled();
  else expect(rubricCalibration).toHaveBeenCalledExactlyOnceWith({ scope, input: textInput, observation: original, answerRevision: 1, workSource: null });
});

const photoScenarios = [
  "photo-only", "photo-with-text", "storage-key", "stale-revision", "wrong-photo", "blank-transcript", "verified-photo", "verified-padded-photo", "transcript-without-glyphs",
] as const;
it.each(photoScenarios)(
  "requires a verified transcript for a subjective photo (%s)", async scenario => {
    const receipt = {
      observationId: textInput.observationId, answerRevision: scenario === "stale-revision" ? 2 : 1,
      workSource: { ...photo, version: scenario === "wrong-photo" ? photo.version + 1 : photo.version },
      text: scenario === "blank-transcript" ? "  "
        : scenario === "verified-padded-photo" ? ANTI_PADDING_COUNTERFACTUAL_TRIPLETS[0]!.templatePaddedExpansion : submission.text,
    };
    const hasReceipt = ["stale-revision", "wrong-photo", "blank-transcript", "verified-photo", "verified-padded-photo", "transcript-without-glyphs"].includes(scenario);
    const useStorageKey = scenario === "storage-key";
    const rubricCalibration = vi.fn(async () => ({ submission, calibration: gate,
      ...(hasReceipt ? { verifiedSubmissionText: receipt } : {}),
    }));
    const fixture = gradingFixture({
      answer: scenario === "photo-with-text" || useStorageKey ? submission.text : "",
      attachedPhoto: !useStorageKey, photoStorageKey: useStorageKey ? "saved-photo" : undefined, rubricCalibration,
      multimodalEvidence: scenario === "verified-photo" || scenario === "verified-padded-photo"
        ? ({ observation, answerRevision, workSource }) => ({
            observationId: observation.id, answerRevision, workSource,
            steps: [{ stepId: "quantity", bbox: [0, 0, 1, 1],
              ast: { kind: "expression", tokens: [{ tokenId: "one", kind: "digit", rawText: "1", confidence: .99 }] } }],
          })
        : undefined,
    });
    const input = useStorageKey ? textInput : photoInput;
    const outcome = scenario === "verified-photo" ? "correct" : "unverified";
    await expect(fixture.service.grade(scope, input)).resolves.toMatchObject({ outcome });
    expect(fixture.apply).toHaveBeenCalledExactlyOnceWith(scope, input, { ...proposal, outcome }, "fixture");
  },
);

it("resolves calibration before dispatch and can retry a failed lookup without paying twice", async () => {
  const rubricCalibration = vi.fn<OpeningRubricCalibrationHook>()
    .mockRejectedValueOnce(new Error("Calibration evidence temporarily unavailable"))
    .mockResolvedValueOnce({ submission, calibration: gate });
  const fixture = gradingFixture({ rubricCalibration });
  await expect(fixture.service.grade(scope, textInput)).rejects.toThrow();
  expect(fixture.reserve).not.toHaveBeenCalled();
  expect(fixture.complete).not.toHaveBeenCalled();
  expect(fixture.settle).not.toHaveBeenCalled();
  expect(fixture.apply).not.toHaveBeenCalled();

  await expect(fixture.service.grade(scope, textInput)).resolves.toMatchObject({ outcome: "correct" });
  expect(rubricCalibration).toHaveBeenCalledTimes(2);
  expect(fixture.reserve).toHaveBeenCalledTimes(1);
  expect(fixture.complete).toHaveBeenCalledTimes(1);
  expect(fixture.settle).toHaveBeenCalledTimes(1);
});
