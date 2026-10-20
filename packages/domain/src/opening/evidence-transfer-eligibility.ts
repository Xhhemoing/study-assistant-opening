import type { ServerEvaluation } from "@aistudy/contracts";
import type { EvidenceEligibility, EvidenceEligibilityValue } from "./evidence-eligibility";

export type TransferSpecification = { fromFamilyId: string; familyId: string; changes: string[]; knowledgeComponents: string[] };
export type TransferEligibility = { usable: EvidenceEligibilityValue; knowledgeComponents: string[]; reasonCodes: string[] };
/** Predeclared changes and matching, server-checked KCs only. An algebra score never certifies a geometric explanation. */
export function evaluateTransferEligibility(input: { specification?: TransferSpecification; eligibility: EvidenceEligibility;
  baselineFamilyObservedBefore: boolean; evaluation?: ServerEvaluation | null }): TransferEligibility {
  const { specification, eligibility, evaluation } = input;
  const unknown = (reason: string): TransferEligibility => ({ usable: "unknown", knowledgeComponents: [], reasonCodes: [reason] });
  if (!specification || !specification.fromFamilyId || !specification.familyId || !specification.changes.length
    || specification.fromFamilyId === specification.familyId) return unknown("transfer_specification_not_recorded");
  if (!input.baselineFamilyObservedBefore) return unknown("transfer_baseline_not_established");
  if (eligibility.independentAttempt !== "yes" || eligibility.usableForCurrentVersion !== "yes" || eligibility.verifiedCorrect !== "yes") {
    return { usable: eligibility.verifiedCorrect === "no" ? "no" : "unknown", knowledgeComponents: [], reasonCodes: ["transfer_performance_not_qualified"] };
  }
  if (evaluation?.evaluatorVersion !== "span-exact-v1" || !evaluation.skills) return unknown("transfer_kc_evaluation_unavailable");
  const verified = evaluation.skills;
  const checks: Record<string, boolean> = { "span:vector-equation": verified.equation === "correct",
    "span:solve-coefficients": verified.coefficients === "correct", "span:check-all-coordinates": verified.allCoordinates === "correct",
    "linear-system:consistency": verified.systemConsistency === "correct" };
  const knowledgeComponents = specification.knowledgeComponents.filter(kc => checks[kc]);
  const gaps = specification.knowledgeComponents.filter(kc => !checks[kc]).map(kc => `transfer_kc_unverified:${kc}`);
  return { usable: knowledgeComponents.length ? "yes" : "unknown", knowledgeComponents,
    reasonCodes: [...(knowledgeComponents.length ? ["predeclared_transfer_verified_for_named_kcs"] : ["transfer_kc_evaluation_unavailable"]), ...gaps] };
}
