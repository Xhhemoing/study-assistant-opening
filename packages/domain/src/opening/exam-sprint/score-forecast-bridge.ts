import type { ExamPack, ExamQuestion, ExamSprintState } from "@aistudy/contracts";
import { createSkillBelief, DAY_MS, type SkillBeliefV1 } from "../../epistemic/belief";
import { updateBeliefWithEvidence } from "../../epistemic/gauss-hermite";
import {
  buildUnifiedDecisionSnapshot, createSharedFullPaperBlueprint, evaluateCrnActionRoi,
  evaluateExamForecast, simulateExamPaper,
  type CandidateStudyAction, type EvaluateCrnActionRoiInput, type ExamBlueprintV1,
  type ExamEvidenceRecord, type WholePaperCalibrationRecord,
} from "../../exam-forecast";
import type { ExamSelectionContext } from "./engine";
import { examAttemptExposureQualification } from "./exposure-qualification";

export { IELTS_ACADEMIC_V1_BLUEPRINT } from "../../exam-forecast";
export type {
  CandidateStudyAction, ExamBlueprintV1, ExamEvidenceRecord, ExamScoreForecastV1, WholePaperCalibrationRecord,
} from "../../exam-forecast";

type MockPool = "mock-a" | "mock-b";
const formId = (pack: ExamPack, pool: ExamQuestion["pool"]) => `${pack.id}:${pack.version}:${pool}`;
const guessRate = (question: ExamQuestion) => question.options.length > 1 ? 1 / question.options.length : 0;
const ITEM_LAPSE = 0.05;

/** One point per objective item. The pack's short forms have their own scale and clock. */
export function buildExamSprintForecastBlueprint(pack: ExamPack, mockPool?: MockPool): ExamBlueprintV1 {
  const pool = mockPool ?? (pack.questions.some(question => question.pool === "mock-a") ? "mock-a"
    : pack.questions.some(question => question.pool === "mock-b") ? "mock-b" : "training");
  const questions = pack.questions.filter(question => question.pool === pool);
  const skillIds = [...new Set(questions.map(question => question.skillId))];
  const sectionId = "objective";
  const partId = "questions";
  const title = `${pack.title} · ${pool}`;
  return createSharedFullPaperBlueprint({
    blueprintId: formId(pack, pool),
    title,
    totalTimeLimitMinutes: questions.reduce((minutes, question) => minutes + question.estimatedMinutes, 0),
    totalPoints: questions.length,
    skillIds,
    sections: [{
      sectionId, label: title, scoringKind: "item_raw_table", timeLimitMinutes: null, weight: 1,
      scoreRange: [0, questions.length], scoreStep: 1,
      parts: [{ partId, label: title, weight: 1, targetItemCount: questions.length, skillIds }],
      items: questions.map(question => ({
        itemId: question.id, sectionId, partId, skillIds: [question.skillId],
        points: 1, guess: guessRate(question), lapse: ITEM_LAPSE,
        timeModel: { mu: Math.log(question.estimatedMinutes * 60), speedLoading: 0, skillLoading: {}, sigma: 0.25 },
      })),
      rawToBandTable: Array.from({ length: questions.length + 1 }, (_, score) => ({ rawMin: score, rawMax: score, score })),
    }],
  });
}

export type ExamSprintForecastEvidenceInput = {
  readonly state: ExamSprintState;
  readonly pack: ExamPack;
  readonly learnerId: string;
  readonly examAtMs: number;
  readonly context?: ExamSelectionContext;
  readonly blueprint?: ExamBlueprintV1;
};

function objectiveLocation(blueprint: ExamBlueprintV1, question: ExamQuestion) {
  const matchingSections = blueprint.sections.filter(section => section.scoringKind === "item_raw_table"
    && section.items?.some(item => item.skillIds.includes(question.skillId)));
  for (const section of matchingSections) {
    const item = section.items?.find(item => item.itemId === question.id && item.skillIds.includes(question.skillId));
    if (item) return { sectionId: section.sectionId, partId: item.partId };
  }
  return matchingSections.length === 1 ? { sectionId: matchingSections[0]!.sectionId } : null;
}

type SprintObjectiveEvidence = ExamEvidenceRecord & {
  readonly itemId: string;
  readonly skillId: string;
  readonly correct: boolean;
};

export function toExamSprintForecastEvidence(input: ExamSprintForecastEvidenceInput): SprintObjectiveEvidence[] {
  const { state, pack, examAtMs, learnerId, context } = input;
  if (!Number.isFinite(examAtMs)) throw new RangeError("examAtMs must be finite");
  const blueprint = input.blueprint ?? buildExamSprintForecastBlueprint(pack);
  const questions = new Map(pack.questions.map(question => [question.id, question]));
  const runs = new Map(state.runs.map(run => [run.id, run]));
  const evidence: SprintObjectiveEvidence[] = [];
  for (const attempt of state.attempts) {
    const question = questions.get(attempt.questionId);
    const run = runs.get(attempt.runId);
    if (!question || !run?.questionIds.includes(attempt.questionId) || attempt.answeredAt === null
      || attempt.help.length > 0 || typeof attempt.correct !== "boolean"
      || !question.options.some(option => option.id === attempt.answer)
      || attempt.correct !== (question.answer === attempt.answer)) continue;
    const mode = run.mode;
    const isMock = mode === "mock-a" || mode === "mock-b";
    const answeredAtMs = Date.parse(attempt.answeredAt);
    const presentedAtMs = Date.parse(attempt.presentedAt);
    if (!Number.isFinite(presentedAtMs) || !Number.isFinite(answeredAtMs) || answeredAtMs < presentedAtMs) continue;
    const publishedAt = isMock ? run.completedAt : attempt.answeredAt;
    if (publishedAt === null || (isMock && run.restoredUngraded)) continue;
    const observedAtMs = Date.parse(publishedAt);
    if (!Number.isFinite(observedAtMs) || observedAtMs < answeredAtMs || observedAtMs > examAtMs) continue;

    const current = context?.ruleEvidence?.[attempt.id];
    if (current && (!current.usable || !current.independent || current.assisted || current.correct !== attempt.correct)) continue;
    const qualification = examAttemptExposureQualification(attempt, state, pack);
    if (qualification.exposureHistoryUncertain || qualification.lessonAssistance !== false || qualification.firstFamilyExposure !== true) continue;
    const location = objectiveLocation(blueprint, question);
    if (!location) continue;
    evidence.push({
      ...location, evidenceId: attempt.id, learnerId, itemId: question.id, skillId: question.skillId,
      paperFamilyId: isMock ? formId(pack, mode) : question.familyId,
      countsTowardMastery: true, assisted: false, exposed: false,
      evidenceKind: isMock ? "independent_mock" : "diagnostic_item", observedAtMs,
      correct: attempt.correct, elapsedSeconds: attempt.durationSeconds,
    });
  }
  return evidence;
}

export type ExamSprintSimulationInput = ExamSprintForecastEvidenceInput & {
  readonly workspaceId: string;
  /** Independently qualified rubric or speech records for an explicit blueprint. */
  readonly supplementalEvidence?: readonly ExamEvidenceRecord[];
  readonly numDraws?: number;
  readonly seed?: number;
};

function prepareSprintSimulation(input: ExamSprintSimulationInput) {
  const blueprint = input.blueprint ?? buildExamSprintForecastBlueprint(input.pack);
  const learnerId = input.learnerId.trim();
  const objectiveEvidence = toExamSprintForecastEvidence({ ...input, blueprint, learnerId })
    .sort((a, b) => a.observedAtMs - b.observedAtMs);
  const questions = new Map(input.pack.questions.map(question => [question.id, question]));
  const beliefs = new Map<string, SkillBeliefV1>();
  for (const record of objectiveEvidence) {
    const question = questions.get(record.itemId)!;
    const belief = beliefs.get(record.skillId) ?? createSkillBelief({
      workspaceId: input.workspaceId, learnerId, courseId: input.pack.id, confirmedSkillVersion: input.pack.version,
    });
    const updated = updateBeliefWithEvidence({
      belief, atMs: record.observedAtMs,
      item: { itemId: record.itemId, a: 1, b: 0, g: guessRate(question), l: ITEM_LAPSE },
      observation: { outcome: record.correct, channel: "unassisted", isFreshFamily: true },
    });
    beliefs.set(record.skillId, updated.belief);
  }
  const supplemental = input.blueprint ? input.supplementalEvidence?.filter(record =>
    record.evidenceKind === "rubric_assessment" || record.evidenceKind === "speech_timing") ?? [] : [];
  return {
    objectiveEvidence,
    simulation: {
      blueprint, learnerId, beliefs: Object.fromEntries(beliefs), evidence: [...objectiveEvidence, ...supplemental],
      examAtMs: input.examAtMs, numDraws: input.numDraws, seed: input.seed,
    },
  };
}

export function simulateExamSprintPaper(input: ExamSprintSimulationInput) {
  return simulateExamPaper(prepareSprintSimulation(input).simulation);
}

type CalibrationOptions = {
  /** Whole-paper records must carry independently made, pre-outcome quantiles. */
  readonly calibrationRecords?: readonly WholePaperCalibrationRecord[];
  readonly targetPaperFamilyIds?: readonly string[];
};

export type ExamSprintScoreForecastInput = ExamSprintSimulationInput & CalibrationOptions & Pick<
  Parameters<typeof evaluateExamForecast>[0],
  "targetKind" | "jointPassTarget" | "jointPassLadder" | "maxInformativeWidth"
>;

function heldOutCalibration(input: CalibrationOptions, blueprint: ExamBlueprintV1) {
  const targetFamilies = new Set([blueprint.blueprintId, ...(input.targetPaperFamilyIds ?? [])].map(id => id.trim()));
  return input.calibrationRecords?.filter(record => !targetFamilies.has(record.paperFamilyId?.trim() ?? "")) ?? [];
}

export function forecastExamSprintScore(input: ExamSprintScoreForecastInput) {
  const { simulation } = prepareSprintSimulation(input);
  return evaluateExamForecast({
    ...input, ...simulation, calibrationRecords: heldOutCalibration(input, simulation.blueprint),
  });
}

export type ExamSprintActionRoiInput = ExamSprintSimulationInput & Pick<
  EvaluateCrnActionRoiInput, "crnSeed" | "candidateAction"
> & { readonly baselineActions?: readonly CandidateStudyAction[] };

export function evaluateExamSprintActionRoi(input: ExamSprintActionRoiInput) {
  const { simulation } = prepareSprintSimulation(input);
  const { crnSeed, candidateAction, baselineActions = [] } = input;
  return evaluateCrnActionRoi({ ...simulation, crnSeed, candidateAction, baselineActions });
}

export type ExamSprintDecisionInput = ExamSprintSimulationInput & CalibrationOptions & Pick<
  Parameters<typeof buildUnifiedDecisionSnapshot>[0],
  "decisionId" | "crnSeed" | "horizonHours" | "executableMinutes" | "baselineActions"
>;

function candidateStudyActions(pack: ExamPack, evidence: readonly SprintObjectiveEvidence[]): CandidateStudyAction[] {
  const titles = new Map(pack.questions.map(question => [question.skillId,
    pack.lessons.find(lesson => lesson.id === question.lessonId)?.title ?? question.skillId]));
  const winsSinceFailure = new Map<string, { first: number; last: number } | null>();
  for (const { skillId, correct, observedAtMs } of evidence) {
    const prior = winsSinceFailure.get(skillId);
    winsSinceFailure.set(skillId, correct ? { first: prior?.first ?? observedAtMs, last: observedAtMs } : null);
  }
  return [...winsSinceFailure.entries()].flatMap(([skillId, wins]): CandidateStudyAction[] => {
    if (wins && wins.last - wins.first >= DAY_MS) return [];
    // A fixed scenario to compare across skills. It makes no claim about measured treatment effects.
    return [{
      actionId: `skill-repair:${skillId}`, title: titles.get(skillId) ?? skillId, kind: "skill_repair",
      durationHours: 0.5, skillEffects: { [skillId]: { abilityDelta: 0.25 } },
    }];
  });
}

export function buildExamSprintDecisionSnapshot(input: ExamSprintDecisionInput) {
  const { simulation, objectiveEvidence } = prepareSprintSimulation(input);
  return buildUnifiedDecisionSnapshot({
    ...input, ...simulation, calibrationRecords: heldOutCalibration(input, simulation.blueprint),
    candidateActions: candidateStudyActions(input.pack, objectiveEvidence),
  });
}
