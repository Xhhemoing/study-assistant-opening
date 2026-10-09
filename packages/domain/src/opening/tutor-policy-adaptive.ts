import type { TutorAction } from "@aistudy/contracts";

/**
 * K02 nodeId-required adaptive recommendation input.
 * Flags are server-derived from SkillEvidence / observations — never client-self-reported.
 */
export type AdaptiveTutorRecommendInput = {
  nodeId: string;
  hasCheckedIndependent: boolean;
  hasAssistance: boolean;
  retestDue: boolean;
};

export type AdaptiveTutorActionKind = TutorAction["kind"];

/**
 * Decision order (plan K02):
 * 1. retestDue → delayed_retest
 * 2. hasAssistance && !hasCheckedIndependent → independent_variant
 * 3. no reliable evidence → clarify
 * 4. hasCheckedIndependent → independent_variant (new context)
 *
 * worked_example / guided stay request-driven (preferences / user ask), not forced here.
 */
export function recommendAdaptiveTutorAction(
  input: AdaptiveTutorRecommendInput,
): AdaptiveTutorActionKind {
  if (!input.nodeId || !String(input.nodeId).trim()) {
    throw new Error("nodeId is required for adaptive tutor recommendation");
  }
  if (input.retestDue) return "delayed_retest";
  if (input.hasAssistance && !input.hasCheckedIndependent) {
    return "independent_variant";
  }
  if (!input.hasCheckedIndependent) return "clarify";
  return "independent_variant";
}

export function isAdaptiveTutorRecommendInput(
  input: unknown,
): input is AdaptiveTutorRecommendInput {
  if (typeof input !== "object" || input === null) return false;
  const record = input as Record<string, unknown>;
  return (
    typeof record.nodeId === "string" &&
    typeof record.hasCheckedIndependent === "boolean" &&
    typeof record.hasAssistance === "boolean" &&
    typeof record.retestDue === "boolean" &&
    // Thin path always carries skillLabel + sessionExposures; adaptive does not.
    !("skillLabel" in record && "sessionExposures" in record)
  );
}
