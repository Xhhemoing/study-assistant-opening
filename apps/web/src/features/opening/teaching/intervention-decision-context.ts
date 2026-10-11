/**
 * Client-side decision context helpers for V2-11 low-interrupt policy.
 * Matches Data `DecideInterventionContext` shape so Experience can feed
 * typing / consecutive reject into decideIntervention when callers exist.
 *
 * Soft gap: Data `appendDecision` repo exists but no HTTP route yet —
 * clients cannot persist the decision ring from the browser in M1.
 * Prefer local context + future thin route; do not invent a second store.
 */

export type InterventionUiDecisionContext = {
  userIsTyping: boolean;
  consecutiveProactiveRejects: number;
  evidenceStrength: "low" | "ok";
  nodeKind: "teach" | "prompt" | "other";
  sessionExposures: ReadonlyArray<"hinted" | "revealed">;
  proposedKind?: string | null;
  userRequestedDepth?: "hint" | "explain" | null;
};

export const DEFAULT_INTERVENTION_UI_DECISION_CONTEXT: InterventionUiDecisionContext = {
  userIsTyping: false,
  consecutiveProactiveRejects: 0,
  evidenceStrength: "ok",
  nodeKind: "other",
  sessionExposures: [],
  proposedKind: null,
  userRequestedDepth: null,
};

/** Build context when the learner is typing (proactive should none/defer). */
export function withUserTyping(
  prev: InterventionUiDecisionContext = DEFAULT_INTERVENTION_UI_DECISION_CONTEXT,
  userIsTyping: boolean,
): InterventionUiDecisionContext {
  return { ...prev, userIsTyping };
}

/** Increment consecutive proactive reject counter (cap semantics live in domain). */
export function withProactiveReject(
  prev: InterventionUiDecisionContext = DEFAULT_INTERVENTION_UI_DECISION_CONTEXT,
): InterventionUiDecisionContext {
  return {
    ...prev,
    consecutiveProactiveRejects: prev.consecutiveProactiveRejects + 1,
  };
}

/** Reset consecutive reject after an accept / explicit help ask. */
export function clearProactiveRejects(
  prev: InterventionUiDecisionContext = DEFAULT_INTERVENTION_UI_DECISION_CONTEXT,
): InterventionUiDecisionContext {
  return { ...prev, consecutiveProactiveRejects: 0 };
}

/**
 * Honesty note for UI / evidence: decision ring persistence is server-only
 * until a thin append route ships. This module only shapes client context.
 */
export const INTERVENTION_DECISION_PERSIST_SOFT_GAP =
  "appendDecision not exposed on /api/opening/intervention-settings; client feeds typing/reject context locally only (M1 soft gap).";
