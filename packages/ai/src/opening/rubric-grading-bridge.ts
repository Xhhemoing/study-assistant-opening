import type { AiGradingInput, AiGradingProposal, LearningObservation, Scope } from "@aistudy/contracts";
import { snapshotPlainRubricData } from "../rubric-calibration/anchor-calibrated-rubric";
import {
  evaluateAnchorCalibratedRubric, evaluateRubricCalibrationGate, snapHalfBand,
  type AnchorCalibratedRubricV1Result, type RubricCalibrationGateFailure,
  type RubricCalibrationGateReport, type RubricSubmissionInput,
} from "../rubric-calibration";

export type SubjectiveGradingCalibration = Parameters<typeof evaluateRubricCalibrationGate>[0];
type RubricWorkSource = { readonly id: string; readonly version: number; readonly physicalPage: number };
type RubricObservation = LearningObservation & { readonly photoStorageKey?: string | null };

/** Trusted server transcript bound to the saved answer revision and its photo. */
export type VerifiedRubricSubmissionText = {
  readonly observationId: string;
  readonly answerRevision: number;
  readonly text: string;
  readonly workSource?: RubricWorkSource;
  readonly photoStorageKey?: string;
};

export type OpeningRubricCalibrationEvidence = {
  readonly submission: Omit<RubricSubmissionInput, "submissionId" | "text">;
  readonly calibration: SubjectiveGradingCalibration | null;
  readonly verifiedSubmissionText?: VerifiedRubricSubmissionText;
};

export type OpeningRubricCalibrationHook = (context: {
  readonly scope: Scope;
  readonly input: AiGradingInput;
  readonly observation: Readonly<RubricObservation>;
  readonly answerRevision: number;
  readonly workSource: RubricWorkSource | null;
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
  readonly rubricResult: AnchorCalibratedRubricV1Result | null;
  readonly gateReport: SubjectiveGradingGateReport;
  readonly masteryEligible: boolean;
} {
  const snapshot = snapshotPlainRubricData(input.submission);
  const submission = snapshot.ok ? snapshot.value as RubricSubmissionInput | null : null;
  // Without verified text there is no submission to compare to anchors or scan for padding.
  const rubricResult = typeof submission?.text === "string" && submission.text.trim()
    ? evaluateAnchorCalibratedRubric(submission) : null;
  const gateReport = evaluateSubjectiveGradingGate(input.calibration);
  const masteryEligible = gateReport.passed && rubricResult?.status === "calibrated"
    && rubricResult.countsTowardMastery && !rubricResult.paddingReport.isTemplatePadded;
  return {
    rubricResult,
    gateReport,
    masteryEligible,
    proposal: masteryEligible ? input.proposal : { ...input.proposal, outcome: "unverified" },
  };
}
