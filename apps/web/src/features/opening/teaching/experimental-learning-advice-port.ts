import type { NextLearningStep } from "@aistudy/domain";
import type { ExperimentalBktAdviceResult } from "../../../../../../packages/domain/src/opening/adaptive/experimental-bkt-advice";

/** Display-only projection: no answers, source text, identities or raw probabilities. */
export type ExperimentalLearningAdvicePort = {
  ruleDecision: Pick<NextLearningStep, "activityKind" | "reasonCode">;
} & (
  | { status: "disabled"; experimentalAdvice: null }
  | { status: "unavailable"; experimentalAdvice: null }
  | { status: "fallback"; experimentalAdvice: null; reason: ExperimentalBktAdviceResult["comparison"]["reason"] }
  | { status: "compared"; experimentalAdvice: { kind: "supported_practice" | "continue_rule" } }
);

/**
 * Host/service injection seam, NOT a new endpoint or a connected backend.
 * The host owns trusted features/heads and the frozen wrapper invocation. Omit
 * enablement until that read path is available. Local UI opt-in cannot enable it.
 * A provider failure is not caught here or disguised as a successful comparison.
 */
export function createExperimentalLearningAdvicePort({
  ruleDecision, experimentEnabled = false, provideExperimentalResult,
}: {
  ruleDecision: NextLearningStep;
  experimentEnabled?: boolean;
  provideExperimentalResult?: () => ExperimentalBktAdviceResult;
}): ExperimentalLearningAdvicePort {
  const rule = { activityKind: ruleDecision.activityKind, reasonCode: ruleDecision.reasonCode };
  if (!experimentEnabled) return { ruleDecision: rule, status: "disabled", experimentalAdvice: null };
  if (!provideExperimentalResult) return { ruleDecision: rule, status: "unavailable", experimentalAdvice: null };
  const result = provideExperimentalResult();
  if (result.comparison.status === "compared" && result.experimentalAdvice) {
    return { ruleDecision: rule, status: "compared", experimentalAdvice: { kind: result.experimentalAdvice.kind } };
  }
  return { ruleDecision: rule, status: "fallback", experimentalAdvice: null, reason: result.comparison.reason };
}
