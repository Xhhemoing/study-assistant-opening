import { evaluateExamForecast } from "./cqr-calibration";
import { validateExamBlueprint } from "./ielts-blueprint";
import {
  generatePaperRandomDraws,
  partitionExamEvidence,
  simulateExamPaper,
  type PaperRandomDraw,
} from "./simulator";
import type {
  CandidateStudyAction,
  CrnActionEvaluation,
  ExamBlueprintV1,
  ExamEvidenceRecord,
  PolicyMode,
  SkillBeliefMap,
  UnifiedDecisionSnapshotV1,
  WholePaperCalibrationRecord,
} from "./types";

function composeActionSetEffects(actions: readonly CandidateStudyAction[]): {
  readonly skillOverrides: Record<string, { abilityDelta: number; logStabilityDelta: number }>;
  readonly speedShift: number;
} {
  const skillOverrides: Record<string, { abilityDelta: number; logStabilityDelta: number }> = {};
  let speedShift = 0;
  for (const action of actions) {
    speedShift += action.expectedSpeedShift ?? 0;
    for (const [skillId, delta] of Object.entries(action.skillEffects ?? {})) {
      const current = skillOverrides[skillId] ?? { abilityDelta: 0, logStabilityDelta: 0 };
      current.abilityDelta += delta.abilityDelta ?? 0;
      current.logStabilityDelta += delta.logStabilityDelta ?? 0;
      skillOverrides[skillId] = current;
    }
  }
  return { skillOverrides, speedShift };
}

/**
 * Paired Common Random Numbers (CRN) marginal ROI evaluation:
 * ROI(a | A) = E[S(A U {a}) - S(A) | D] / durationHours(a).
 * Explicitly forbids CQR interval subtraction.
 */
export function evaluateCrnActionRoi(input: {
  readonly blueprint: ExamBlueprintV1;
  readonly learnerId?: string;
  readonly beliefs: SkillBeliefMap;
  readonly evidence: readonly ExamEvidenceRecord[];
  readonly examAtMs: number;
  readonly baselineActions: readonly CandidateStudyAction[];
  readonly candidateAction: CandidateStudyAction;
  readonly crnSeed: number;
  readonly numDraws?: number;
  readonly precomputedDraws?: readonly PaperRandomDraw[];
}): CrnActionEvaluation {
  if (!(input.candidateAction.durationHours > 0) || !Number.isFinite(input.candidateAction.durationHours)) {
    throw new RangeError("candidateAction.durationHours must be positive and finite");
  }
  const numDraws = Math.max(2, Math.round(input.numDraws ?? 400));
  const draws =
    input.precomputedDraws ?? generatePaperRandomDraws(input.blueprint, numDraws, input.crnSeed);
  if (draws.length === 0) throw new RangeError("precomputedDraws must be non-empty");

  const isolatedEvidence =
    input.learnerId !== undefined
      ? partitionExamEvidence(input.evidence, { learnerId: input.learnerId }).admitted
      : input.evidence;

  const baseEffects = composeActionSetEffects(input.baselineActions);
  const plusEffects = composeActionSetEffects([...input.baselineActions, input.candidateAction]);

  const baseSim = simulateExamPaper({
    blueprint: input.blueprint,
    beliefs: input.beliefs,
    evidence: isolatedEvidence,
    examAtMs: input.examAtMs,
    precomputedDraws: draws,
    skillOverrides: baseEffects.skillOverrides,
    speedShift: baseEffects.speedShift,
  });

  const plusSim = simulateExamPaper({
    blueprint: input.blueprint,
    beliefs: input.beliefs,
    evidence: isolatedEvidence,
    examAtMs: input.examAtMs,
    precomputedDraws: draws,
    skillOverrides: plusEffects.skillOverrides,
    speedShift: plusEffects.speedShift,
  });

  const n = draws.length;
  const diffs = new Array<number>(n);
  let sumDiff = 0;
  for (let i = 0; i < n; i++) {
    const d = plusSim.timedScores[i]! - baseSim.timedScores[i]!;
    diffs[i] = d;
    sumDiff += d;
  }
  const pairedMeanGain = sumDiff / n;
  let sqSum = 0;
  for (let i = 0; i < n; i++) {
    const dev = diffs[i]! - pairedMeanGain;
    sqSum += dev * dev;
  }
  const monteCarloSe = n > 1 ? Math.sqrt(sqSum / (n * (n - 1))) : 0;
  const roiBandPerHour = pairedMeanGain / input.candidateAction.durationHours;
  const timeSqueezeReduction = baseSim.timeSqueezeDelta - plusSim.timeSqueezeDelta;

  let superlinearSynergy = Math.max(0, timeSqueezeReduction);
  if (input.baselineActions.length > 0) {
    const emptySim = simulateExamPaper({
      blueprint: input.blueprint,
      beliefs: input.beliefs,
      evidence: isolatedEvidence,
      examAtMs: input.examAtMs,
      precomputedDraws: draws,
    });
    const aloneEffects = composeActionSetEffects([input.candidateAction]);
    const aloneSim = simulateExamPaper({
      blueprint: input.blueprint,
      beliefs: input.beliefs,
      evidence: isolatedEvidence,
      examAtMs: input.examAtMs,
      precomputedDraws: draws,
      skillOverrides: aloneEffects.skillOverrides,
      speedShift: aloneEffects.speedShift,
    });
    const standaloneGain = aloneSim.timedExpectedScore - emptySim.timedExpectedScore;
    superlinearSynergy = Math.max(timeSqueezeReduction, pairedMeanGain - standaloneGain);
  }

  return {
    actionId: input.candidateAction.actionId,
    durationHours: input.candidateAction.durationHours,
    baselineMeanScore: baseSim.timedExpectedScore,
    withActionMeanScore: plusSim.timedExpectedScore,
    pairedMeanGain,
    monteCarloSe,
    roiBandPerHour,
    timeSqueezeReduction,
    superlinearSynergy,
  };
}

export function buildUnifiedDecisionSnapshot(input: {
  readonly decisionId: string;
  readonly blueprint: ExamBlueprintV1;
  readonly learnerId: string;
  readonly beliefs: SkillBeliefMap;
  readonly evidence: readonly ExamEvidenceRecord[];
  readonly calibrationRecords: readonly WholePaperCalibrationRecord[];
  readonly examAtMs: number;
  readonly crnSeed: number;
  readonly horizonHours: number;
  readonly executableMinutes?: number;
  readonly baselineActions?: readonly CandidateStudyAction[];
  readonly candidateActions: readonly CandidateStudyAction[];
  readonly numDraws?: number;
}): UnifiedDecisionSnapshotV1 {
  if (!Number.isFinite(input.horizonHours) || input.horizonHours < 0) {
    throw new RangeError("horizonHours must be finite and non-negative");
  }
  const rawExec = input.executableMinutes ?? input.horizonHours * 60;
  const executableMinutes = Number.isFinite(rawExec) ? Math.max(0, Math.floor(rawExec)) : 0;
  const policyMode: PolicyMode = input.horizonHours <= 72 ? "sprint_72h" : "cycle_90d";
  const maxRecoveryMinutes = Math.floor((executableMinutes * 30) / 100);

  const forecast = evaluateExamForecast({
    blueprint: input.blueprint,
    learnerId: input.learnerId,
    beliefs: input.beliefs,
    evidence: input.evidence,
    calibrationRecords: input.calibrationRecords,
    examAtMs: input.examAtMs,
    numDraws: input.numDraws,
    seed: input.crnSeed,
  });

  const blueprintValid = validateExamBlueprint(input.blueprint).length === 0;
  const baselineActions = input.baselineActions ?? [];
  const studyCandidates = input.candidateActions.filter(
    (a) => a.kind !== "recovery" && Number.isFinite(a.durationHours) && a.durationHours > 0,
  );
  const recoveryCandidates = input.candidateActions.filter((a) => a.kind === "recovery");

  let allocatedRecoveryMinutes = 0;
  const selectedRecoveryIds: string[] = [];
  if (forecast.status === "calibrated_forecast_ready") {
    for (const recovery of recoveryCandidates) {
      const rawMins = recovery.recoveryMinutes ?? recovery.durationHours * 60;
      if (!Number.isFinite(rawMins) || rawMins <= 0) continue;
      const mins = Math.round(rawMins);
      if (mins > 0 && allocatedRecoveryMinutes + mins <= maxRecoveryMinutes) {
        allocatedRecoveryMinutes += mins;
        selectedRecoveryIds.push(recovery.actionId);
      }
    }
  }

  let rankedActions: CrnActionEvaluation[] = [];
  const selectedActionIds: string[] = [];

  const learnerId = input.learnerId.trim();
  const { admitted: learnerEvidence } = learnerId
    ? partitionExamEvidence(input.evidence, { learnerId })
    : { admitted: [] as readonly ExamEvidenceRecord[] };

  if (blueprintValid && learnerId.length > 0 && studyCandidates.length > 0) {
    const numDraws = Math.max(2, Math.round(input.numDraws ?? 400));
    const draws = generatePaperRandomDraws(input.blueprint, numDraws, input.crnSeed);
    rankedActions = studyCandidates
      .map((candidateAction) =>
        evaluateCrnActionRoi({
          blueprint: input.blueprint,
          learnerId,
          beliefs: input.beliefs,
          evidence: learnerEvidence,
          examAtMs: input.examAtMs,
          baselineActions,
          candidateAction,
          crnSeed: input.crnSeed,
          numDraws,
          precomputedDraws: draws,
        }),
      )
      .sort((a, b) => b.roiBandPerHour - a.roiBandPerHour || a.actionId.localeCompare(b.actionId));

    if (forecast.status === "calibrated_forecast_ready") {
      let remainingStudyMinutes = executableMinutes - allocatedRecoveryMinutes;
      for (const evalItem of rankedActions) {
        if (evalItem.pairedMeanGain <= 0) continue;
        const mins = Math.ceil(evalItem.durationHours * 60);
        if (mins <= remainingStudyMinutes) {
          remainingStudyMinutes -= mins;
          selectedActionIds.push(evalItem.actionId);
        }
      }
    }
  }

  if (forecast.status === "calibrated_forecast_ready") {
    selectedActionIds.push(...selectedRecoveryIds);
  }

  return {
    schemaVersion: 1,
    decisionId: input.decisionId,
    blueprintId: input.blueprint.blueprintId,
    crnSeed: input.crnSeed,
    horizonHours: input.horizonHours,
    policyMode,
    executableMinutes,
    allocatedRecoveryMinutes,
    maxRecoveryMinutes,
    forecast,
    baselineActionIds: baselineActions.map((a) => a.actionId),
    rankedActions,
    selectedActionIds,
  };
}
