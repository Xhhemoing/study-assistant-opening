import type { AiGradingInput, AiGradingProposal, LearningObservation, Scope } from "@aistudy/contracts";
import { snapshotPlainRubricData } from "../rubric-calibration/anchor-calibrated-rubric";
import {
  evaluateAnchorCalibratedRubric, evaluateRubricCalibrationGate, snapHalfBand,
  type AnchorCalibratedRubricV1Result, type RubricCalibrationGateFailure,
  type RubricCalibrationGateReport, type RubricSubmissionInput,
} from "../rubric-calibration";

export type SubjectiveGradingCalibration = Parameters<typeof evaluateRubricCalibrationGate>[0];
export type OpeningRubricCalibrationEvidence = {
  readonly submission: Omit<RubricSubmissionInput, "submissionId" | "text">;
  readonly calibration: SubjectiveGradingCalibration | null;
};

export type OpeningRubricCalibrationHook = (context: {
  readonly scope: Scope;
  readonly input: AiGradingInput;
  readonly observation: Readonly<LearningObservation>;
  readonly answerRevision: number;
}) => OpeningRubricCalibrationEvidence | null | Promise<OpeningRubricCalibrationEvidence | null>;

export type SubjectiveGradingGateReport = Omit<RubricCalibrationGateReport, "metrics" | "failures"> & {
  readonly metrics: RubricCalibrationGateReport["metrics"] & {
    readonly adjacentAgreement: number | null;
  };
  readonly failures: readonly (RubricCalibrationGateFailure | "adjacent_agreement_below_threshold")[];
};

const MIN_ADJACENT_AGREEMENT = 0.85;

function evaluateSubjectiveGradingGate(calibration: SubjectiveGradingCalibration | null): SubjectiveGradingGateReport {
  const snapshot = snapshotPlainRubricData(calibration);
  const cohort = snapshot.ok ? snapshot.value as SubjectiveGradingCalibration | null : null;
  const coreReport = evaluateRubricCalibrationGate(cohort ?? { benchmarkItems: [], counterfactualTriplets: [] });
  let adjacentAgreement: number | null = null;
  if (coreReport.passed && cohort) {
    // The core validates cohort identity and coverage. Use the same admitted point scores as QWK.
    const adjacentCount = cohort.benchmarkItems.filter(({ trueBand, evaluation }) => {
      const score = evaluation?.band ?? evaluation?.rawBand;
      return evaluation?.status === "calibrated" && typeof score === "number" && score >= 0 && score <= 9
        && typeof trueBand === "number" && trueBand >= 0 && trueBand <= 9
        && Math.abs(snapHalfBand(trueBand) - snapHalfBand(score)) <= 0.5;
    }).length;
    adjacentAgreement = adjacentCount / coreReport.metrics.admissibleCount;
  }
  const passed = coreReport.passed && adjacentAgreement !== null && adjacentAgreement >= MIN_ADJACENT_AGREEMENT;
  return {
    ...coreReport,
    passed,
    metrics: { ...coreReport.metrics, adjacentAgreement },
    failures: coreReport.passed && !passed ? [...coreReport.failures, "adjacent_agreement_below_threshold"] : coreReport.failures,
  };
}

export function evaluateCalibratedSubjectiveGrading(input: {
  readonly proposal: AiGradingProposal;
  readonly submission: RubricSubmissionInput;
  readonly calibration: SubjectiveGradingCalibration | null;
}): {
  readonly proposal: AiGradingProposal;
  readonly rubricResult: AnchorCalibratedRubricV1Result;
  readonly gateReport: SubjectiveGradingGateReport;
} {
  // Anchor evaluation runs the position swaps and detectTemplatePadding on the same submission.
  const rubricResult = evaluateAnchorCalibratedRubric(input.submission);
  const gateReport = evaluateSubjectiveGradingGate(input.calibration);
  const eligible = gateReport.passed && rubricResult.status === "calibrated"
    && rubricResult.countsTowardMastery && !rubricResult.paddingReport.isTemplatePadded;
  return {
    rubricResult,
    gateReport,
    proposal: eligible ? input.proposal : { ...input.proposal, outcome: "unverified" },
  };
}
