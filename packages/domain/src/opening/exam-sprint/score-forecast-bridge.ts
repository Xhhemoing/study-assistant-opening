import type { ExamAttempt, ExamPack, ExamQuestion, ExamRun, ExamSkillSummary, ExamSprintState } from "@aistudy/contracts";
import { createSkillBelief, type SkillBeliefV1 } from "../../epistemic/belief";
import { updateBeliefWithEvidence } from "../../epistemic/gauss-hermite";
import {
  buildUnifiedDecisionSnapshot, createSharedFullPaperBlueprint, evaluateCrnActionRoi,
  DEFAULT_EXAM_SIMULATION_DRAWS, evaluateExamForecast, MAX_SIMULATION_DP_CELLS, MAX_SIMULATION_ITEM_EVALS, simulateExamPaper,
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

const mockPoolFor = (run: ExamRun): MockPool | null => run.mode === "mock-a" || run.mode === "mock-b" ? run.mode : null;

/** A mock becomes visible at submission. Learning happened when the item was answered. */
export function examSprintAttemptAnswerTime(attempt: ExamAttempt, run: ExamRun | undefined, cutoffMs: number): number | null {
  if (!run?.questionIds.includes(attempt.questionId) || attempt.answeredAt === null) return null;
  const answeredAtMs = Date.parse(attempt.answeredAt);
  const presentedAtMs = Date.parse(attempt.presentedAt);
  if (!Number.isFinite(answeredAtMs) || !Number.isFinite(presentedAtMs)
    || answeredAtMs < presentedAtMs || answeredAtMs > cutoffMs) return null;
  if (mockPoolFor(run)) {
    if (run.restoredUngraded || run.completedAt === null) return null;
    const completedAtMs = Date.parse(run.completedAt);
    if (!Number.isFinite(completedAtMs) || completedAtMs < answeredAtMs || completedAtMs > cutoffMs) return null;
  }
  return answeredAtMs;
}

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
    if (!question || !run || attempt.help.length > 0 || typeof attempt.correct !== "boolean"
      || !question.options.some(option => option.id === attempt.answer)
      || attempt.correct !== (question.answer === attempt.answer)) continue;
    const observedAtMs = examSprintAttemptAnswerTime(attempt, run, examAtMs);
    if (observedAtMs === null) continue;

    const current = context?.ruleEvidence?.[attempt.id];
    if (current && (!current.usable || !current.independent || current.assisted || current.correct !== attempt.correct)) continue;
    const qualification = examAttemptExposureQualification(attempt, state, pack);
    if (qualification.exposureHistoryUncertain || qualification.lessonAssistance !== false || qualification.firstFamilyExposure !== true) continue;
    const location = objectiveLocation(blueprint, question);
    if (!location) continue;
    const mockPool = mockPoolFor(run);
    evidence.push({
      ...location, evidenceId: attempt.id, learnerId, itemId: question.id, skillId: question.skillId,
      paperFamilyId: mockPool ? formId(pack, mockPool) : question.familyId,
      countsTowardMastery: true, assisted: false, exposed: false,
      evidenceKind: mockPool ? "independent_mock" : "diagnostic_item", observedAtMs,
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

function defaultExamSprintDraws(blueprint: ExamBlueprintV1): number {
  let itemCount = 0;
  let dpCellsPerDraw = 0;
  for (const section of blueprint.sections) {
    if (!section.items) continue;
    itemCount += section.items.length;
    if (section.scoringKind === "item_raw_table") {
      const points = section.items.reduce((sum, item) => sum + (item.points ?? 1), 0);
      dpCellsPerDraw += section.items.length * (points + 1);
    }
  }
  // CRN actions can turn fixed item probabilities into variable ones, so budget every draw.
  return Math.max(1, Math.min(DEFAULT_EXAM_SIMULATION_DRAWS,
    Math.floor(MAX_SIMULATION_DP_CELLS / dpCellsPerDraw), Math.floor(MAX_SIMULATION_ITEM_EVALS / itemCount)));
}

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
  const rubricSections = new Set(blueprint.sections.filter(section => section.scoringKind === "rubric_band").map(section => section.sectionId));
  const supplemental = input.blueprint ? input.supplementalEvidence?.filter(record =>
    rubricSections.has(record.sectionId) && (record.evidenceKind === "rubric_assessment"
      || record.evidenceKind === "speech_timing")) ?? [] : [];
  return {
    blueprint, learnerId, beliefs: Object.fromEntries(beliefs), evidence: [...objectiveEvidence, ...supplemental],
    examAtMs: input.examAtMs, numDraws: input.numDraws ?? defaultExamSprintDraws(blueprint), seed: input.seed,
  };
}

export function simulateExamSprintPaper(input: ExamSprintSimulationInput) {
  return simulateExamPaper(prepareSprintSimulation(input));
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
  const simulation = prepareSprintSimulation(input);
  return evaluateExamForecast({
    ...input, ...simulation, calibrationRecords: heldOutCalibration(input, simulation.blueprint),
  });
}

export type ExamSprintActionRoiInput = ExamSprintSimulationInput & Pick<
  EvaluateCrnActionRoiInput, "crnSeed" | "candidateAction"
> & { readonly baselineActions?: readonly CandidateStudyAction[] };

export function evaluateExamSprintActionRoi(input: ExamSprintActionRoiInput) {
  const simulation = prepareSprintSimulation(input);
  const { crnSeed, candidateAction, baselineActions = [] } = input;
  return evaluateCrnActionRoi({ ...simulation, crnSeed, candidateAction, baselineActions });
}

export type ExamSprintDecisionInput = ExamSprintSimulationInput & CalibrationOptions & Pick<
  Parameters<typeof buildUnifiedDecisionSnapshot>[0],
  "decisionId" | "crnSeed" | "horizonHours" | "executableMinutes" | "baselineActions"
>;

export function buildForecastDecisionWithSkillSummaries(input: ExamSprintDecisionInput, skills: readonly ExamSkillSummary[]) {
  const simulation = prepareSprintSimulation(input);
  const modeledSkillIds = new Set(simulation.blueprint.skillIds);
  const candidateActions = skills.filter(skill => modeledSkillIds.has(skill.skillId) && (skill.status === "weak" || skill.status === "usable"))
    .map(({ skillId, title }): CandidateStudyAction => ({
      // A fixed scenario for comparing skills, with a hypothetical treatment effect.
      actionId: `skill-repair:${skillId}`, title, kind: "skill_repair",
      durationHours: 0.5, skillEffects: { [skillId]: { abilityDelta: 0.25 } },
    }));
  return buildUnifiedDecisionSnapshot({
    ...input, ...simulation, calibrationRecords: heldOutCalibration(input, simulation.blueprint),
    candidateActions,
  });
}
