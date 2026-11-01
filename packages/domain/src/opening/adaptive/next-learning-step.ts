import type { LearningDecisionCandidate } from "../learning-decision";
import type { LearningPhase, NextLearningStep, NextLearningStepInput } from "./snapshot-sources";

export type LegacyAdaptiveTutorInput = {
  nodeId: string;
  hasCheckedIndependent: boolean;
  hasAssistance: boolean;
  retestDue: boolean;
};
export type LegacyAdaptiveTutorKind = "clarify" | "guided" | "worked_example" | "independent_variant" | "delayed_retest";
export type LegacyThinTutorInput = {
  skillLabel: string;
  currentPage: number | null;
  sourceIds: string[];
  nodeId?: string | null;
  problemRef?: string | null;
  sessionExposures: ReadonlyArray<"hinted" | "revealed">;
  assistedSuccessOnCurrentItem: boolean;
  retestDue: boolean;
  evidenceIds?: string[];
};
export type LegacyThinTutorAction = {
  kind: "clarify" | "guided" | "worked_example" | "independent_variant" | "delayed_retest";
  skillLabel: string; currentPage: number | null; nodeId: string | null;
  problemRef: string | null; reason: string; evidenceIds: string[];
};

export const NEXT_LEARNING_STEP_VERSION = "next-learning-step-2";

/** Four-stage selection is metadata around the existing activity policy. */
export function learningPhaseForInput(input: Pick<NextLearningStepInput, "observations" | "dueRetest" | "learningPhase" | "phaseSource">): { phase: LearningPhase; source: "automatic" | "explicit" } {
  if (input.learningPhase === "maintain" && !input.dueRetest) return { phase: "explore", source: input.phaseSource ?? "explicit" };
  if (input.learningPhase) return { phase: input.learningPhase, source: input.phaseSource ?? "explicit" };
  if (input.dueRetest) return { phase: "maintain", source: "automatic" };
  const observations = input.observations.filter(row => row.usableForCurrentVersion === "yes");
  if (!observations.length || observations.every(row => row.verifiedCorrect === "unknown")) return { phase: "explore", source: "automatic" };
  if (observations[0]?.verifiedCorrect === "no") return { phase: "new_learning", source: "automatic" };
  if (observations[0]?.assistance === "hinted" || observations[0]?.assistance === "revealed") return { phase: "consolidate", source: "automatic" };
  return { phase: "explore", source: "automatic" };
}

export function withLearningPhase(decision: NextLearningStep, input: NextLearningStepInput): NextLearningStep {
  // Keep the historical shape byte-for-byte for legacy callers and receipts.
  if (input.learningPhase === undefined && input.dueRetest === undefined && input.phaseSource === undefined) return decision;
  const phase = learningPhaseForInput(input);
  return { ...decision, phase: phase.phase, phaseSource: phase.source };
}

/** Capture only branches actually evaluated, in priority order; later rules did not compete. */
export function captureNextLearningStep(input: NextLearningStepInput): {
  decision: NextLearningStep; candidates: LearningDecisionCandidate[];
} {
  const candidates: LearningDecisionCandidate[] = [];
  const check = (action: NextLearningStep["activityKind"], eligible: boolean, reason: string, rejected: string, evidenceRefs: string[] = []) => {
    candidates.push({ action, eligible, reasonCodes: [eligible ? reason : rejected], evidenceRefs });
    return eligible;
  };
  const result = (activityKind: NextLearningStep["activityKind"], reasonCode: NextLearningStep["reasonCode"], focusObservationId: string | null = null) =>
    ({ decision: withLearningPhase({ activityKind, focusObservationId, reasonCode }, input), candidates });
  const phase = learningPhaseForInput(input);
  if (input.learningPhase === "new_learning") {
    check("full_explain", true, "explicit_new_learning", "explicit_new_learning");
    return result("full_explain", "requested_full");
  }
  if (input.dueRetest && phase.phase === "maintain") {
    check("transfer_check", true, "due_retest", "due_retest");
    return result("transfer_check", "due_retest");
  }
  if (input.learningPhase === "consolidate") {
    check("reduced_help_practice", true, "explicit_consolidate", "explicit_consolidate");
    return result("reduced_help_practice", "requested_consolidate");
  }
  if (check("full_explain", !!input.wantsFullExplanation, "requested_full", "not_requested_full")) return result("full_explain", "requested_full");
  const observations = input.observations.filter(row => row.usableForCurrentVersion === "yes");
  const latest = observations[0], refs = observations.map(row => `observation:${row.id}`);
  if (check("diagnose", !latest, "no_evidence", "has_current_evidence", refs)) return result("diagnose", "no_evidence");
  const assistedErrors = observations.filter(row => row.verifiedCorrect === "no"
    && (row.assistance === "hinted" || row.assistance === "revealed") && row.errors?.some(error => error.source === "verified_steps"));
  const [newerError, olderError] = assistedErrors;
  const sharedError = newerError?.errors?.find(error => error.source === "verified_steps"
    && olderError?.errors?.some(previous => previous.source === "verified_steps" && previous.label === error.label));
  if (check("full_explain", Boolean(newerError && olderError && sharedError), "repeated_assisted_error", "not_repeated_assisted_error",
    newerError && olderError ? [`observation:${newerError.id}`, `observation:${olderError.id}`] : refs))
    return result("full_explain", "repeated_assisted_error", newerError!.id);
  if (check("targeted_explain", latest!.verifiedCorrect === "no", "verified_incorrect", "latest_not_verified_incorrect", [`observation:${latest!.id}`]))
    return result("targeted_explain", "verified_incorrect", latest!.id);
  if (check("diagnose", observations.every(row => row.verifiedCorrect === "unknown"), "unverified_only", "has_verified_evidence", refs)) return result("diagnose", "unverified_only");
  const recent = observations.slice(0, 3);
  const assistedCount = recent.filter(row => row.assistance === "hinted" || row.assistance === "revealed").length;
  if (check("reduced_help_practice", assistedCount > recent.length / 2, "assistance_dependent", "no_assisted_majority", recent.map(row => `observation:${row.id}`)))
    return result("reduced_help_practice", "assistance_dependent");
  if (check("transfer_check", input.status === "observed_independent", "independent", "not_observed_independent", refs)) return result("transfer_check", "independent");
  if (check("transfer_check", latest!.verifiedCorrect === "yes" && latest!.independentAttempt === "unknown"
    && latest!.assistance !== "hinted" && latest!.assistance !== "revealed", "correct_needs_independent_check", "no_unknown_independence_check", [`observation:${latest!.id}`]))
    return result("transfer_check", "correct_needs_independent_check");
  check("diagnose", true, "needs_check", "needs_check", refs);
  return result("diagnose", "needs_check");
}

/** Select the next activity from effective observation heads, newest first. */
function legacyVariantProblemRef(problemRef: string): string {
  const suffix = ":variant";
  const base = problemRef.trim();
  if (!base) return `variant${suffix}`;
  if (base.endsWith(suffix)) return `${base}-2`;
  return `${base}${suffix}`;
}

function legacyAdaptive(input: LegacyAdaptiveTutorInput): LegacyAdaptiveTutorKind {
  if (!input.nodeId || !String(input.nodeId).trim()) throw new Error("nodeId is required for adaptive tutor recommendation");
  if (input.retestDue) return "delayed_retest";
  if (input.hasAssistance && !input.hasCheckedIndependent) return "independent_variant";
  if (!input.hasCheckedIndependent) return "clarify";
  return "independent_variant";
}

function legacyThin(input: LegacyThinTutorInput): LegacyThinTutorAction {
  const skillLabel = input.skillLabel.trim();
  if (!skillLabel) throw new Error("skillLabel is required");
  const base = { skillLabel, currentPage: input.currentPage, nodeId: input.nodeId ?? null, evidenceIds: input.evidenceIds ?? [] };
  const problemRef = input.problemRef ?? null;
  if (input.retestDue) return { ...base, kind: "delayed_retest", problemRef, reason: "L02 delayed retest is due; start a new session with empty exposure." };
  if (input.assistedSuccessOnCurrentItem && problemRef) return { ...base, kind: "independent_variant", problemRef: legacyVariantProblemRef(problemRef), reason: "Assisted success on the current item; try a new independent variant." };
  if (input.sessionExposures.includes("revealed")) return { ...base, kind: "independent_variant", problemRef: problemRef ? legacyVariantProblemRef(problemRef) : "variant:1", reason: "Full explain already delivered; next step is a new item." };
  if (input.sessionExposures.includes("hinted")) return { ...base, kind: "worked_example", problemRef, reason: "Hint delivered; offer a full worked example if still stuck." };
  if (input.currentPage == null) return { ...base, kind: "clarify", problemRef, reason: "No current page selected; clarify the target material/page first." };
  return { ...base, kind: "guided", problemRef, reason: "Material page selected; start with a next-step guided hint." };
}

export function nextLearningStep(input: NextLearningStepInput): NextLearningStep;
export function nextLearningStep(input: { kind: "adaptive"; input: LegacyAdaptiveTutorInput }): { kind: LegacyAdaptiveTutorKind };
export function nextLearningStep(input: { kind: "thin"; input: LegacyThinTutorInput }): LegacyThinTutorAction;
export function nextLearningStep(input: NextLearningStepInput | { kind: "adaptive"; input: LegacyAdaptiveTutorInput } | { kind: "thin"; input: LegacyThinTutorInput }): NextLearningStep | { kind: LegacyAdaptiveTutorKind } | LegacyThinTutorAction {
  if ("kind" in input) {
    if (input.kind === "adaptive") return { kind: legacyAdaptive(input.input) };
    return legacyThin(input.input);
  }
  return captureNextLearningStep(input).decision;
}
