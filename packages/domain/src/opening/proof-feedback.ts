import type { AiGradingProposal, ProofFeedback } from "@aistudy/contracts";
import { counterfactualProofSteps, proofContextSupportsRealScalarCheck, verifyStandaloneProofEquationClaim } from "./symbolic-answer-bridge";

type ProofContext = Partial<Pick<AiGradingProposal, "feedback" | "criteria" | "transcription">>;

const MATH_SUBJECT = /(?:equalit(?:y|ies)|identit(?:y|ies)|equations?|expressions?|derivatives?|antiderivatives?|integrals?|expansions?|simplifications?|values?|results?|calculations?|computations?|signs?|coefficients?|constants?|terms?|sides?)/u.source;
const MATH_ERROR = /(?:false|wrong|incorrect|invalid|unequal|mistaken)/u.source;
const EQUALITY_DISPUTE = [
  new RegExp(String.raw`\b${MATH_SUBJECT}(?:\s+of\s+\w+)?\s+(?:(?:is|are|was|were|looks?|seems?)\s+(?:(?:mathematically|numerically|algebraically)\s+)?${MATH_ERROR}|(?:does|do)\s+not\s+(?:equal|hold|match))\b|\b${MATH_ERROR}\s+${MATH_SUBJECT}\b`, "iu"),
  /\b(?:not\s+equal|(?:does|do)\s+not\s+equal)\b|^\s*(?:it\s+)?(?:does|do)\s+not\s+(?:hold|match)\b|!=|≠|\\(?:neq|ne)\b/iu,
  /\b(?:algebra(?:ic)?|arithmeti(?:c|cal)|calculation|computation|differentiation|integration|expansion|factori[sz]ation|factoring|sign)\s+(?:errors?|mistakes?)\b|\bmiscalculat\w*\b(?!\s+nothing\b)|\b(?:missing|omitted)\s+(?:(?:the|a|an|integration|constant|negative|positive)\s+)*(?:constants?|terms?|signs?)\b/iu,
  /等式不成立|恒等式不成立|不相等|不等于|计算错误|展开错误|化简错误|求导错误|积分错误|代数错误|符号错误|系数错误|漏项/u,
];
const NEGATED_MATH_ERROR = new RegExp(String.raw`\b(?:no|not|without)\s+(?:(?:a|an|any)\s+)?(?:${MATH_ERROR}|(?:(?:algebraic|arithmetic|calculation|computation|differentiation|integration|expansion|factoring|sign)\s+)?(?:errors?|mistakes?))\b`, "giu");
const EQUALITY_AFFIRMATION = /\b(?:equalit(?:y|ies)|identit(?:y|ies)|equations?)\s+(?:holds?\b|(?:is|are)\s+(?:true|correct|valid)\b)|\b(?:both\s+)?sides\s+are\s+equal\b|恒等式成立|等式成立|两边相等/iu;

function disputesEquality(text: string | undefined): boolean {
  if (!text || EQUALITY_AFFIRMATION.test(text)) return false;
  const assertion = text.replace(NEGATED_MATH_ERROR, " ").replace(/\b(?:doesn['’]t|don['’]t)\b/giu, "does not");
  return EQUALITY_DISPUTE.some(pattern => pattern.test(assertion));
}

/** Recognizes explicit task commands only, rather than guessing every proof-shaped answer. */
export function proofFeedbackRequiredByQuestion(stem:string){
  return /(?:^|[，。；：:!?！？\s）).、])(?:请|试)?(?:证明|推导|求证)|\b(?:prove|show\s+that|derive)\b/iu.test(stem);
}
/** Use symbolic checks to reconcile verdicts about the math in a required proof step. */
export function proofFeedbackAllowsOutcome(
  outcome: AiGradingProposal["outcome"], proof: ProofFeedback | undefined, context?: ProofContext,
) {
  if (!proof || outcome === "unverified") return true;
  const required = proof.steps.filter(step => step.required);
  const realScalar = proofContextSupportsRealScalarCheck([
    ...proof.steps.flatMap(step => [step.claim, step.feedback, step.repairPrompt ?? ""]),
    context?.feedback ?? "", context?.transcription ?? "",
    ...context?.criteria?.flatMap(criterion => [criterion.label, criterion.feedback]) ?? [],
  ]);
  if (outcome === "correct") {
    if (proof.coverage !== "complete" || !required.length || required.some(step => step.verdict !== "correct")) return false;
    if (!realScalar) return true;
    const counterfactual = counterfactualProofSteps(proof.steps);
    return required.every(step => counterfactual.has(step) || verifyStandaloneProofEquationClaim(step.claim).status !== "inequivalent");
  }
  const proposalDispute = realScalar && (disputesEquality(context?.feedback) ||
    context?.criteria?.some(criterion => criterion.verdict === "incorrect" && disputesEquality(criterion.feedback)));
  return required.some(step => step.verdict === "incorrect" && (!realScalar ||
    !(proposalDispute || disputesEquality(step.feedback) || disputesEquality(step.repairPrompt)) ||
    !verifyStandaloneProofEquationClaim(step.claim).unconditional));
}
