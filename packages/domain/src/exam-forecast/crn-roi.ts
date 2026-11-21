import { evaluateExamForecast } from "./cqr-calibration";
import { safeArithmeticMean, validateExamBlueprint } from "./ielts-blueprint";
import {
  DEFAULT_EXAM_SIMULATION_DRAWS,
  generatePaperRandomDraws,
  partitionExamEvidence,
  resolveDrawsCount,
  sectionPartIdsMap,
  sectionRangesMap,
  simulateExamPaper,
  validateNumDraws,
  validatePrecomputedDraws,
  type PaperRandomDraw,
  type SkillDeltaOverride,
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
  readonly skillOverrides: ReadonlyMap<string, SkillDeltaOverride>;
  readonly speedShift: number;
} {
  const skillOverrides = new Map<string, { abilityDelta: number; logStabilityDelta: number }>();
  const seenActionIds = new Set<string>();
  let speedShift = 0;
  for (const action of actions) {
    const trimmedId = action.actionId.trim();
    if (!trimmedId || seenActionIds.has(trimmedId)) continue;
    seenActionIds.add(trimmedId);
    if (action.expectedSpeedShift !== undefined && !Number.isFinite(action.expectedSpeedShift)) {
      throw new RangeError("action.expectedSpeedShift must be finite when provided");
    }
    speedShift += action.expectedSpeedShift ?? 0;
    for (const [skillId, delta] of Object.entries(action.skillEffects ?? {})) {
      if (delta.abilityDelta !== undefined && !Number.isFinite(delta.abilityDelta)) {
        throw new RangeError("action.skillEffects.abilityDelta must be finite when provided");
      }
      if (delta.logStabilityDelta !== undefined && !Number.isFinite(delta.logStabilityDelta)) {
        throw new RangeError("action.skillEffects.logStabilityDelta must be finite when provided");
      }
      const current = skillOverrides.get(skillId) ?? { abilityDelta: 0, logStabilityDelta: 0 };
      current.abilityDelta += delta.abilityDelta ?? 0;
      current.logStabilityDelta += delta.logStabilityDelta ?? 0;
      skillOverrides.set(skillId, current);
    }
  }
  return { skillOverrides, speedShift };
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type EvaluateCrnActionRoiInput = {
  readonly blueprint: ExamBlueprintV1;
  readonly learnerId: string;
  readonly beliefs: SkillBeliefMap;
  readonly evidence: readonly ExamEvidenceRecord[];
  readonly examAtMs: number;
  readonly baselineActions: readonly CandidateStudyAction[];
  readonly candidateAction: CandidateStudyAction;
  readonly crnSeed: number;
  readonly numDraws?: number;
  readonly precomputedDraws?: readonly PaperRandomDraw[];
};

/**
 * Paired Common Random Numbers (CRN) marginal ROI evaluation:
 * ROI(a | A) = E[S(A U {a}) - S(A) | D] / durationHours(a).
 * Explicitly forbids CQR interval subtraction.
 */
export function evaluateCrnActionRoi(input: EvaluateCrnActionRoiInput): CrnActionEvaluation {
  const blueprintIssues = validateExamBlueprint(input.blueprint);
  if (blueprintIssues.length > 0) {
    throw new RangeError(`Invalid exam blueprint: ${blueprintIssues.join(", ")}`);
  }
  const trimmedLearnerId = input.learnerId.trim();
  if (!trimmedLearnerId) {
    throw new RangeError("learnerId must be a non-empty string");
  }
  if (!input.candidateAction.actionId.trim()) {
    throw new RangeError("candidateAction.actionId must be a non-empty string");
  }
  if (!(input.candidateAction.durationHours > 0) || !Number.isFinite(input.candidateAction.durationHours)) {
    throw new RangeError("candidateAction.durationHours must be positive and finite");
  }
  const numDraws = resolveDrawsCount(input.numDraws, input.precomputedDraws, DEFAULT_EXAM_SIMULATION_DRAWS);
  if (input.precomputedDraws !== undefined) {
    validatePrecomputedDraws(input.blueprint, input.precomputedDraws);
  }
  const draws =
    input.precomputedDraws ?? generatePaperRandomDraws(input.blueprint, numDraws, input.crnSeed);

  const isolatedEvidence = partitionExamEvidence(input.evidence, {
    learnerId: trimmedLearnerId,
    examAtMs: input.examAtMs,
    sectionRanges: sectionRangesMap(input.blueprint),
    sectionParts: sectionPartIdsMap(input.blueprint),
  }).admitted;

  const baseEffects = composeActionSetEffects(input.baselineActions);
  const plusEffects = composeActionSetEffects([...input.baselineActions, input.candidateAction]);

  const baseSim = simulateExamPaper({
    blueprint: input.blueprint,
    learnerId: trimmedLearnerId,
    beliefs: input.beliefs,
    evidence: isolatedEvidence,
    examAtMs: input.examAtMs,
    precomputedDraws: draws,
    skillOverrides: baseEffects.skillOverrides,
    speedShift: baseEffects.speedShift,
  });

  const plusSim = simulateExamPaper({
    blueprint: input.blueprint,
    learnerId: trimmedLearnerId,
    beliefs: input.beliefs,
    evidence: isolatedEvidence,
    examAtMs: input.examAtMs,
    precomputedDraws: draws,
    skillOverrides: plusEffects.skillOverrides,
    speedShift: plusEffects.speedShift,
  });

  const n = draws.length;
  const diffs = new Array<number>(n);
  const squeezeDeltas = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const d = plusSim.timedScores[i]! - baseSim.timedScores[i]!;
    diffs[i] = d;
    const baseSqueeze = baseSim.untimedScores[i]! - baseSim.timedScores[i]!;
    const plusSqueeze = plusSim.untimedScores[i]! - plusSim.timedScores[i]!;
    squeezeDeltas[i] = baseSqueeze - plusSqueeze;
  }
  const pairedMeanGain = safeArithmeticMean(diffs);
  let scale = Math.abs(pairedMeanGain);
  for (let i = 0; i < n; i++) {
    const absD = Math.abs(diffs[i]!);
    if (absD > scale) scale = absD;
  }
  let monteCarloSe = 0;
  if (n > 1 && scale > 0) {
    const meanScaled = pairedMeanGain / scale;
    let sumSqScaled = 0;
    for (let i = 0; i < n; i++) {
      const devScaled = diffs[i]! / scale - meanScaled;
      sumSqScaled += devScaled * devScaled;
    }
    monteCarloSe = Math.sqrt(sumSqScaled / (n * (n - 1))) * scale;
  }
  const roiBandPerHour = pairedMeanGain / input.candidateAction.durationHours;
  const timeSqueezeReduction = safeArithmeticMean(squeezeDeltas);

  let superlinearSynergy = Math.max(0, timeSqueezeReduction);
  if (input.baselineActions.length > 0) {
    const emptySim = simulateExamPaper({
      blueprint: input.blueprint,
      learnerId: trimmedLearnerId,
      beliefs: input.beliefs,
      evidence: isolatedEvidence,
      examAtMs: input.examAtMs,
      precomputedDraws: draws,
    });
    const aloneEffects = composeActionSetEffects([input.candidateAction]);
    const aloneSim = simulateExamPaper({
      blueprint: input.blueprint,
      learnerId: trimmedLearnerId,
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

function deduplicateActionsById(
  actions: readonly CandidateStudyAction[],
  excludeIds?: ReadonlySet<string>,
): CandidateStudyAction[] {
  const seen = new Set<string>(excludeIds);
  const deduped: CandidateStudyAction[] = [];
  for (const action of actions) {
    const id = action.actionId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(action);
  }
  return deduped;
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
  const numDraws = validateNumDraws(input.numDraws, DEFAULT_EXAM_SIMULATION_DRAWS);
  const rawExec = input.executableMinutes ?? input.horizonHours * 60;
  const executableMinutes = Number.isFinite(rawExec) ? Math.max(0, Math.floor(rawExec)) : 0;
  const policyMode: PolicyMode = input.horizonHours <= 72 ? "sprint_72h" : "cycle_90d";

  const forecast = evaluateExamForecast({
    blueprint: input.blueprint,
    learnerId: input.learnerId,
    beliefs: input.beliefs,
    evidence: input.evidence,
    calibrationRecords: input.calibrationRecords,
    examAtMs: input.examAtMs,
    numDraws,
    seed: input.crnSeed,
  });

  const maxRecoveryMinutes =
    forecast.status === "calibrated_forecast_ready"
      ? Math.floor((executableMinutes * 30) / 100)
      : 0;

  const blueprintValid = validateExamBlueprint(input.blueprint).length === 0;
  const baselineActions = deduplicateActionsById(input.baselineActions ?? []);
  const baselineActionIds = new Set(baselineActions.map((a) => a.actionId.trim()));
  const dedupedCandidates = deduplicateActionsById(input.candidateActions, baselineActionIds);
  const studyCandidates = dedupedCandidates.filter(
    (a) => a.kind !== "recovery" && Number.isFinite(a.durationHours) && a.durationHours > 0,
  );
  const recoveryCandidates = dedupedCandidates.filter((a) => a.kind === "recovery");

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
    ? partitionExamEvidence(input.evidence, {
        learnerId,
        examAtMs: input.examAtMs,
        sectionRanges: sectionRangesMap(input.blueprint),
        sectionParts: sectionPartIdsMap(input.blueprint),
      })
    : { admitted: [] as readonly ExamEvidenceRecord[] };

  if (blueprintValid && learnerId.length > 0 && studyCandidates.length > 0) {
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
      .sort((a, b) => b.roiBandPerHour - a.roiBandPerHour || compareCodeUnits(a.actionId, b.actionId));

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
