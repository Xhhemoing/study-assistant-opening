import {
  ANTI_PADDING_COUNTERFACTUAL_TRIPLETS, SENTINEL_ANCHOR_ESSAYS, createModelGateway, createOpeningAiGradingService,
  evaluateCalibratedSubjectiveGrading, evaluateRubricCalibrationGate, getSentinelAnchorsForDimension,
  type OpeningAiGradingServiceDeps, type PairwiseSwapComparison, type RubricCalibrationPoint, type RubricSubmissionInput,
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
    expect([...result.rubricResult.inconsistencyReasons, ...result.rubricResult.masteryExclusionReasons]).toContain(reason);
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
    expect(result.rubricResult.countsTowardMastery).toBe(true);
    expect(result.gateReport.passed).toBe(false);
    expect(result.proposal).toEqual({ ...proposal, outcome: "unverified" });
  });
});

const gradingScenarios = ["legacy", "objective", "uncalibrated", "padded", "verified"] as const;
it.each(gradingScenarios)("applies the rubric policy before persistence and reuses the saved result (%s)", async scenario => {
  const scope: Scope = { workspaceId: "00000000-0000-4000-8000-000000000001", ownerUserId: "00000000-0000-4000-8000-000000000002" };
  const input = { observationId: "00000000-0000-4000-8000-000000000003" };
  const answer = scenario === "padded" ? ANTI_PADDING_COUNTERFACTUAL_TRIPLETS[0]!.templatePaddedExpansion : submission.text;
  const original = { id: input.observationId, answer, outcome: "unverified" } as LearningObservation;
  const output: ProviderOutput = {
    text: JSON.stringify(proposal), inputTokens: 1, outputTokens: 1, citedChunkIds: [], candidates: [], requestId: null,
  };
  const complete = vi.fn(async () => output);
  const gateway = createModelGateway({ resolve: async () => ({ provider: { complete }, inputCentsPerMillion: 1,
    outputCentsPerMillion: 1, modelSnapshot: { id: "model", providerId: "fixture", modelName: "fixture", inputCentsPerMillion: 1, outputCentsPerMillion: 1 } }) });
  let saved: LearningObservation | null = null;
  const apply = vi.fn<OpeningAiGradingServiceDeps["repository"]["apply"]>(async (_scope, _input, assessed) =>
    (saved = { ...original, outcome: assessed.outcome }));
  const reserve = vi.fn(async () => ({ id: "reserved", state: "reserved" as const }));
  const settle = vi.fn(async () => undefined);
  const rubricCalibration = vi.fn(async () => scenario === "objective" ? null
    : { submission, calibration: scenario === "uncalibrated" ? null : gate });
  const service = createOpeningAiGradingService({
    repository: {
      context: async () => ({ observation: original, existing: saved, stem: "Essay prompt", referenceText: "", misconceptions: [],
        workSource: null, answerRevision: 1, operationId: "fixture-grading" }),
      apply, ledger: async () => "unsent",
    },
    gateway, budget: () => ({ reserve, settle, claimExecution: async () => true, release: async () => undefined, markUnknown: async () => undefined }),
    images: async () => [],
    ...(scenario === "legacy" ? {} : { rubricCalibration }),
  });

  const assessed = { ...proposal, outcome: scenario === "uncalibrated" || scenario === "padded" ? "unverified" : "correct" };
  await expect(service.grade(scope, input)).resolves.toMatchObject({ outcome: assessed.outcome });
  expect(apply).toHaveBeenCalledExactlyOnceWith(scope, input, assessed, "fixture");
  await expect(service.grade(scope, input)).resolves.toBe(saved);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(settle).toHaveBeenCalledTimes(1);
  if (scenario === "legacy") expect(rubricCalibration).not.toHaveBeenCalled();
  else expect(rubricCalibration).toHaveBeenCalledExactlyOnceWith({ scope, input, observation: original, answerRevision: 1 });
});
