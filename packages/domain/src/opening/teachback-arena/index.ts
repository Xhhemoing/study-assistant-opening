import { assertTeachbackWindowClear, type TeachbackTarget, type TeachbackWindowSnapshot } from "./retest-window";

export { binarySearchTeachback } from "./binary-search";
export { assertTeachbackWindowClear, checkTeachbackRetestConflict, ActiveRetestWindowConflict } from "./retest-window";
export type { TeachbackTarget, TeachbackRetestWindow, TeachbackWindowSnapshot } from "./retest-window";

export const TEACHBACK_ARENA_VERSION = "teachback-arena-v1";
export type DerivationStep = { readonly stepId: string; readonly text: string };
type Choice = { readonly id: string; readonly text: string };

export type TeachbackArenaChallenge = {
  readonly challengeId: string;
  readonly target: TeachbackTarget;
  readonly prompt: string;
  readonly steps: readonly DerivationStep[];
  readonly repairs: readonly Choice[];
  readonly invariantRules: readonly Choice[];
  /** Author-owned rubric. Excluded from the learner's launch view. */
  readonly rubric: {
    readonly firstFlawedStepId: string;
    readonly symptomStepIds: readonly string[];
    readonly validRebuttals: readonly { selectedRepairId: string; invariantRuleId: string }[];
  };
};

export type TeachbackDiagnosisSubmission = {
  challengeId: string;
  selectedRepairId: string;
  invariantRuleId: string;
} & ({ stepId: string; stepIndex?: number } | { stepId?: string; stepIndex: number });

export type TeachbackVerdict = "full_rebuttal_verified" | "symptom_step_trapped" | "right_step_wrong_repair" | "missed_flaw";

export function launchTeachbackArena(challenge: TeachbackArenaChallenge, snapshot: TeachbackWindowSnapshot) {
  assertTeachbackWindowClear(challenge.target, snapshot);
  const { challengeId, prompt, steps, repairs, invariantRules } = challenge;
  return { version: TEACHBACK_ARENA_VERSION, challengeId, prompt, steps, repairs, invariantRules };
}

/** Record-time evaluation requires a fresh snapshot even after a successful launch. */
export function evaluateTeachbackDiagnosis(challenge: TeachbackArenaChallenge, submission: TeachbackDiagnosisSubmission,
  snapshot: TeachbackWindowSnapshot): TeachbackVerdict {
  assertTeachbackWindowClear(challenge.target, snapshot);
  if (submission.challengeId !== challenge.challengeId) throw new Error("Diagnosis belongs to a different teachback challenge");

  // stepIndex is zero-based. When supplied together, both locators must agree.
  const { stepId, stepIndex } = submission;
  const selected = stepIndex === undefined ? challenge.steps.find(step => step.stepId === stepId)
    : Number.isInteger(stepIndex) ? challenge.steps[stepIndex] : undefined;
  if (!selected || (stepId !== undefined && selected.stepId !== stepId)) return "missed_flaw";

  const { rubric } = challenge;
  if (selected.stepId !== rubric.firstFlawedStepId) {
    return rubric.symptomStepIds.includes(selected.stepId) ? "symptom_step_trapped" : "missed_flaw";
  }
  const verified = rubric.validRebuttals.some(pair => pair.selectedRepairId === submission.selectedRepairId
    && pair.invariantRuleId === submission.invariantRuleId);
  return verified ? "full_rebuttal_verified" : "right_step_wrong_repair";
}

export function recordTeachbackDiagnosis(challenge: TeachbackArenaChallenge, submission: TeachbackDiagnosisSubmission,
  snapshot: TeachbackWindowSnapshot) {
  const verdict = evaluateTeachbackDiagnosis(challenge, submission, snapshot);
  return { version: TEACHBACK_ARENA_VERSION, challengeId: challenge.challengeId, submission: { ...submission },
    evaluatedAt: snapshot.now.toISOString(), verdict };
}
