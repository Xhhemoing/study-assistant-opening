import type { SkillEvidence } from "@aistudy/contracts";
import { recommendAdaptiveTutorAction, type AdaptiveTutorActionKind } from "./tutor-policy-adaptive";

export type RetestCloseAssistance = "independent" | "hinted" | "revealed" | "unknown";
export type RetestCloseOutcome = "correct" | "incorrect" | "unverified";
export type RetestCloseDimension = SkillEvidence["dimension"];

/** Delayed retest default dimension — transfer (new context after delay). */
export const RETEST_CLOSE_DEFAULT_DIMENSION: RetestCloseDimension = "transfer";

/**
 * Exact label match only — same rule as Experience knowledge-node-lookup.
 * SkillEvidence stays node-keyed; no fuzzy merge.
 */
export function nodeIdForSkillLabel(
  snapshot:
    | { nodes: ReadonlyArray<{ id: string; label: string }> }
    | null
    | undefined,
  skillLabel: string,
): string | null {
  const needle = skillLabel.trim();
  if (!needle || !snapshot?.nodes?.length) return null;
  const match = snapshot.nodes.find((node) => node.label === needle);
  return match?.id ?? null;
}

/**
 * Plan K02 / K02a: unassisted correct retest may append SkillEvidence.
 * Assisted / unverified / incorrect must not upgrade to independent mastery.
 */
export function shouldAppendRetestEvidence(input: {
  assistance: RetestCloseAssistance;
  outcome: RetestCloseOutcome;
}): boolean {
  return input.assistance === "independent" && input.outcome === "correct";
}

export type RetestSkillLinkFields = {
  nodeId: string;
  dimension: RetestCloseDimension;
};

/**
 * Resolve SkillEvidence fields for a retest completion observation.
 * Returns null when not a linkable retest close (no retestId, assisted, or no node).
 */
export function prepareRetestSkillLink(input: {
  retestId?: string | null;
  assistance: RetestCloseAssistance;
  outcome: RetestCloseOutcome;
  skillLabel: string;
  nodeId?: string | null;
  dimension?: RetestCloseDimension | null;
  snapshot:
    | { nodes: ReadonlyArray<{ id: string; label: string }> }
    | null
    | undefined;
}): RetestSkillLinkFields | null {
  if (!input.retestId) return null;
  if (!shouldAppendRetestEvidence(input)) return null;
  const explicit = input.nodeId?.trim() || null;
  const nodeId = explicit ?? nodeIdForSkillLabel(input.snapshot, input.skillLabel);
  if (!nodeId) return null;
  return {
    nodeId,
    dimension: input.dimension ?? RETEST_CLOSE_DEFAULT_DIMENSION,
  };
}

/** Next tutor action after a successful independent retest close (due cleared). */
export function nextTutorKindAfterRetestClose(nodeId: string): AdaptiveTutorActionKind {
  return recommendAdaptiveTutorAction({
    nodeId,
    hasCheckedIndependent: true,
    hasAssistance: false,
    retestDue: false,
  });
}
