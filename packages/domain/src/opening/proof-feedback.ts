import type { AiGradingProposal, ProofFeedback } from "@aistudy/contracts";
import { verifyStandaloneProofEquationClaim } from "./symbolic-answer-bridge";
/** Recognizes explicit task commands only, rather than guessing every proof-shaped answer. */
export function proofFeedbackRequiredByQuestion(stem:string){
  return /(?:^|[，。；：:!?！？\s）).、])(?:请|试)?(?:证明|推导|求证)|\b(?:prove|show\s+that|derive)\b/iu.test(stem);
}
/** Step feedback stays model judgement; contradictory/partial proof claims cannot establish a positive total. */
export function proofFeedbackAllowsOutcome(outcome: AiGradingProposal["outcome"], proof: ProofFeedback | undefined) {
  if (!proof) return true;
  const required = proof.steps.filter(step => step.required);
  if (outcome === "correct") {
    return proof.coverage === "complete" && required.length > 0 && required.every(step =>
      step.verdict === "correct" && verifyStandaloneProofEquationClaim(step.claim).status !== "inequivalent");
  }
  if (outcome === "incorrect") {
    return required.some(step =>
      step.verdict === "incorrect" && !verifyStandaloneProofEquationClaim(step.claim).unconditional);
  }
  return true;
}
