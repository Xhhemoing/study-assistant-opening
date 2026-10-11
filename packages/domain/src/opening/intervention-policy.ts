import type {
  InterventionDecisionKind,
  InterventionDecisionRecord,
  InterventionPrefs,
  InterventionPrefsPatch,
  InterventionTrigger,
} from "@aistudy/contracts";
import {
  CONSECUTIVE_PROACTIVE_REJECT_LIMIT,
  INTERVENTION_DECISION_RING_MAX,
} from "@aistudy/contracts";

export {
  CONSECUTIVE_PROACTIVE_REJECT_LIMIT,
  INTERVENTION_DECISION_RING_MAX,
} from "@aistudy/contracts";

/** Forbidden nag / dwell API surface — tests assert these are not exported. */
// deliberately no N_MINUTES / mustAskEvery / dwellStuck exports

export type DecideInterventionContext = {
  userIsTyping: boolean;
  consecutiveProactiveRejects: number;
  evidenceStrength: "low" | "ok";
  nodeKind: "teach" | "prompt" | "other";
  sessionExposures: ReadonlyArray<"hinted" | "revealed">;
  proposedKind?: string | null;
  userRequestedDepth?: "hint" | "explain" | null;
  /** Hard budget/auth block — only then may user_help_ask defer. */
  hardBlock?: boolean;
};

export type DecideInterventionInput = {
  prefs: InterventionPrefs;
  trigger: InterventionTrigger;
  context: DecideInterventionContext;
};

export type DecideInterventionResult = {
  decision: InterventionDecisionKind;
  reason: string;
};

const ESCALATE_KINDS = new Set([
  "worked_example",
  "explain",
  "full_answer",
  "reveal",
]);

function isProactive(trigger: InterventionTrigger): boolean {
  return trigger === "system_proactive" || trigger === "tutor_recommend";
}

function proactiveSuppressed(prefs: InterventionPrefs): boolean {
  return prefs.quietMode || prefs.proactivity === "off";
}

function isEscalateKind(proposedKind: string | null | undefined): boolean {
  if (!proposedKind) return false;
  return ESCALATE_KINDS.has(proposedKind);
}

/**
 * session > course > global. Missing patch keys inherit.
 * Returns a new object; does not mutate `global`.
 */
export function resolveInterventionPrefs(
  global: InterventionPrefs,
  coursePatch: InterventionPrefsPatch | null | undefined,
  sessionPatch: InterventionPrefsPatch | null | undefined,
): InterventionPrefs {
  const apply = (
    base: InterventionPrefs,
    patch: InterventionPrefsPatch | null | undefined,
  ): InterventionPrefs => {
    if (!patch) {
      return {
        proactivity: base.proactivity,
        depth: base.depth,
        quietMode: base.quietMode,
        nodes: { ...base.nodes },
      };
    }
    return {
      proactivity: patch.proactivity ?? base.proactivity,
      depth: patch.depth ?? base.depth,
      quietMode: patch.quietMode ?? base.quietMode,
      nodes: {
        allowOnTeach: patch.nodes?.allowOnTeach ?? base.nodes.allowOnTeach,
        allowOnPrompt: patch.nodes?.allowOnPrompt ?? base.nodes.allowOnPrompt,
        allowOnLowEvidence:
          patch.nodes?.allowOnLowEvidence ?? base.nodes.allowOnLowEvidence,
      },
    };
  };
  return apply(apply(global, coursePatch), sessionPatch);
}

export function decideIntervention(
  input: DecideInterventionInput,
): DecideInterventionResult {
  const { prefs, trigger, context } = input;

  if (trigger === "user_help_ask") {
    if (context.hardBlock) {
      return { decision: "defer", reason: "budget_or_auth_block" };
    }
    // Quiet / off still answer explicit asks (help-ask ≠ interrupt).
    if (context.userRequestedDepth === "explain") {
      return { decision: "respond", reason: "user_request" };
    }
    return { decision: "respond", reason: "user_request" };
  }

  if (!isProactive(trigger)) {
    return { decision: "none", reason: "unknown_trigger" };
  }

  if (proactiveSuppressed(prefs)) {
    return {
      decision: "none",
      reason: prefs.quietMode ? "quiet_mode" : "proactivity_off",
    };
  }

  if (context.userIsTyping) {
    return { decision: "none", reason: "user_typing" };
  }

  if (context.consecutiveProactiveRejects >= CONSECUTIVE_PROACTIVE_REJECT_LIMIT) {
    return { decision: "none", reason: "consecutive_reject" };
  }

  if (context.nodeKind === "teach" && !prefs.nodes.allowOnTeach) {
    return { decision: "none", reason: "node_disallowed" };
  }
  if (context.nodeKind === "prompt" && !prefs.nodes.allowOnPrompt) {
    return { decision: "none", reason: "node_disallowed" };
  }

  if (
    context.evidenceStrength === "low" &&
    !prefs.nodes.allowOnLowEvidence
  ) {
    return { decision: "defer", reason: "low_evidence" };
  }

  // After hint alone: never auto-respond full / worked example.
  if (
    context.sessionExposures.includes("hinted") &&
    isEscalateKind(context.proposedKind)
  ) {
    return { decision: "offer", reason: "depth_blocks_auto_expand" };
  }

  if (prefs.depth === "hint_only" && isEscalateKind(context.proposedKind)) {
    return { decision: "offer", reason: "depth_blocks_auto_expand" };
  }

  // minimal: prefer offer over respond; never invent schedule.
  if (prefs.proactivity === "minimal") {
    return { decision: "offer", reason: "proactivity_minimal" };
  }

  if (prefs.proactivity === "high" && !isEscalateKind(context.proposedKind)) {
    return { decision: "respond", reason: "proactivity_high" };
  }

  return { decision: "offer", reason: "proactivity_balanced" };
}

/** Count trailing proactive none/defer rejects from newest-first or oldest-first ring. */
export function countConsecutiveProactiveRejects(
  decisions: ReadonlyArray<Pick<InterventionDecisionRecord, "trigger" | "decision">>,
): number {
  let count = 0;
  // Ring is oldest→newest; walk from end.
  for (let i = decisions.length - 1; i >= 0; i--) {
    const d = decisions[i]!;
    if (d.trigger !== "system_proactive" && d.trigger !== "tutor_recommend") {
      break;
    }
    if (d.decision === "none" || d.decision === "defer") {
      // Treat UI reject of offer as reject trail; also policy none/defer.
      count += 1;
      continue;
    }
    if (d.decision === "offer" || d.decision === "respond") {
      // Offer that was accepted/acted breaks reject streak only if later UI records acceptance.
      // Consecutive *reject* means user dismissed offers — callers should append
      // decision none with reason consecutive_reject_user when UI rejects.
      break;
    }
  }
  return count;
}

/**
 * Pure checkpoint merge: set session overlay without touching durable prefs.
 * Preserves other checkpoint keys (drafts, anchors, …).
 */
export function mergeSessionInterventionPrefs(
  checkpoint: Record<string, unknown>,
  patch: InterventionPrefsPatch | null,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...checkpoint };
  if (patch === null) {
    delete next.interventionPrefs;
  } else {
    next.interventionPrefs = patch;
  }
  return next;
}

/**
 * Append decision to ring (max INTERVENTION_DECISION_RING_MAX); preserve other keys.
 */
export function appendInterventionDecision(
  checkpoint: Record<string, unknown>,
  record: InterventionDecisionRecord,
  max = INTERVENTION_DECISION_RING_MAX,
): Record<string, unknown> {
  const prev = Array.isArray(checkpoint.interventionDecisions)
    ? (checkpoint.interventionDecisions as InterventionDecisionRecord[])
    : [];
  const nextRing = [...prev, record].slice(-Math.max(1, max));
  return {
    ...checkpoint,
    interventionDecisions: nextRing,
  };
}

export function readSessionInterventionPrefs(
  checkpoint: Record<string, unknown> | null | undefined,
): InterventionPrefsPatch | null {
  if (!checkpoint || checkpoint.interventionPrefs == null) return null;
  return checkpoint.interventionPrefs as InterventionPrefsPatch;
}

export function readInterventionDecisions(
  checkpoint: Record<string, unknown> | null | undefined,
): InterventionDecisionRecord[] {
  if (!checkpoint || !Array.isArray(checkpoint.interventionDecisions)) return [];
  return checkpoint.interventionDecisions as InterventionDecisionRecord[];
}

/**
 * Gate helper (T14): tutor recommend may propose escalate-after-hint, but
 * decision forbids auto `respond`. Callers must not surface auto-act when false.
 */
export function mayAutoRespondProactive(
  decision: DecideInterventionResult,
): boolean {
  return decision.decision === "respond";
}

export function gateTutorRecommendAfterDecision(
  proposedKind: string | null | undefined,
  decision: DecideInterventionResult,
): {
  proposedKind: string | null | undefined;
  decision: InterventionDecisionKind;
  reason: string;
  allowAutoRespond: boolean;
  allowOffer: boolean;
} {
  const allowAutoRespond = mayAutoRespondProactive(decision);
  const allowOffer =
    decision.decision === "offer" || decision.decision === "respond";
  return {
    proposedKind,
    decision: decision.decision,
    reason: decision.reason,
    allowAutoRespond,
    allowOffer,
  };
}
