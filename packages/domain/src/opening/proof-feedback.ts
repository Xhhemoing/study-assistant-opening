import type { AiGradingProposal, ProofFeedback } from "@aistudy/contracts";
import {
  counterfactualProofSteps, feedbackDeniesProvenEquality, proofContextSupportsRealScalarCheck, verifyStandaloneProofEquationClaim,
} from "./symbolic-answer-bridge";

type ProofContext = Partial<Pick<AiGradingProposal, "feedback" | "criteria" | "transcription">>;

const MATH_SUBJECT = /(?:equalit(?:y|ies)|identit(?:y|ies)|equations?|expressions?|derivatives?|antiderivatives?|integrals?|expansions?|simplifications?|values?|results?|calculations?|computations?|signs?|coefficients?|constants?|terms?|sides?)/u.source;
const MATH_ERROR = /(?:false|wrong|incorrect|invalid|unequal|mistaken)/u.source;
const EQUALITY_DISPUTE = [
  new RegExp(String.raw`\b${MATH_SUBJECT}(?:\s+of\s+\w+)?\s+(?:(?:is|are|was|were|looks?|seems?)\s+(?:(?:mathematically|numerically|algebraically)\s+)?${MATH_ERROR}|(?:does|do)\s+not\s+(?:equal|hold|match))\b|\b${MATH_ERROR}\s+${MATH_SUBJECT}\b`, "iu"),
  /\b(?:not\s+equal|(?:does|do)\s+not\s+equal)\b|^\s*(?:it\s+)?(?:does|do)\s+not\s+(?:hold|match)\b/iu,
  /\b(?:algebra(?:ic)?|arithmeti(?:c|cal)|calculation|computation|differentiation|integration|expansion|factori[sz]ation|factoring|sign)\s+(?:errors?|mistakes?)\b|\bmiscalculat\w*\b(?!\s+nothing\b)|\b(?:missing|omitted)\s+(?:(?:the|a|an|integration|constant|negative|positive)\s+)*(?:constants?|terms?|signs?)\b/iu,
  /等式不成立|恒等式不成立|不相等|不等于|计算错误|展开错误|化简错误|求导错误|积分错误|代数错误|符号错误|系数错误|漏项/u,
];
const NEGATED_MATH_ERROR = new RegExp(String.raw`\b(?:no|not|without)\s+(?:(?:a|an|any)\s+)?(?:${MATH_ERROR}|(?:(?:algebraic|arithmetic|calculation|computation|differentiation|integration|expansion|factoring|sign)\s+)?(?:errors?|mistakes?))\b`, "giu");
const EQUALITY_AFFIRMATION = /\b(?:equalit(?:y|ies)|identit(?:y|ies)|equations?)\s+(?:holds?\b|(?:is|are)\s+(?:true|correct|valid)\b)|\b(?:both\s+)?sides\s+are\s+equal\b|恒等式成立|等式成立|两边相等/iu;
const RESTRICTION = /\b(?:(?:only|merely|just|solely)\s+(?:when|if|for|at|on|in)|except|unless|not\s+for\s+all|fails?\s+(?:when|if|for|at|outside))\b|(?:仅|只)(?:在|当)|除非|不恒成立|并非恒等式/iu;
const RESTRICTED_EQUALITY = [
  /\b(?:equalit(?:y|ies)|identit(?:y|ies)|equations?|expressions?|formulas?|it|sides?)\s+(?:holds?|(?:is|are)\s+(?:true|valid|correct|equal))\s+(?:only|merely|just|solely)\s+(?:when|if|for|at|on|in)\b/iu,
  /\b(?:holds?|(?:is|are)\s+(?:true|valid|equal|correct))\s+(?:except|unless)\b/iu,
  /\b(?:not\s+an\s+identity|(?:do(?:es)?\s+not\s+hold|not\s+(?:true|valid|equal))\s+(?:for\s+all|everywhere|identically|in\s+general|always)|not\s+for\s+all|fails?\s+(?:when|if|for|at|outside))\b/iu,
  /(?:仅|只)(?:在|当)[^。！？；\r\n]*成立|(?:等式|恒等式|两边相等)[^。！？；\r\n]*除非|不恒成立|并非恒等式/u,
];
const INFERENCE_CRITIQUE = [
  /\b(?:circular\s+(?:reasoning|argument|proof)|beg(?:s|ging)?\s+the\s+question|assum\w*\s+(?:(?:the|your)\s+)?(?:conclusion|identity|result|what\s+(?:(?:was|is)\s+to\s+be\s+proved|you\s+(?:had|were\s+asked|need(?:ed)?)\s+to\s+prove))|restat\w*\s+(?:the\s+)?(?:target|conclusion|goal|identity|result))\b/iu,
  /\b(?:(?:miss(?:ing|es)?|lack(?:s|ing)?|without|no|skip\w*|omit\w*)\s+(?:(?:the|a|any|an|an?\s+explicit|necessary|required|intermediate)\s+)*(?:justification|reasoning|proof|derivation|steps?)|(?:do(?:es)?\s+not|doesn['’]t|don['’]t)\s+follow|(?:disallowed|forbidden|unauthori[sz]ed|not\s+allowed\s+to\s+use)\s+(?:the\s+)?(?:theorem|method|rule))\b/iu,
  /循环论证|未证先用|直接假设|重述结论|缺少(?:证明|推导|理由|依据)|未经证明|跳步|(?:禁止|不能|不得)(?:使用|采用)(?:该|此)?(?:定理|方法)/u,
];

function disputesEquality(text: string | undefined): boolean {
  if (!text) return false;
  const assertion = text.replace(NEGATED_MATH_ERROR, " ").replace(/\b(?:doesn['’]t|don['’]t)\b/giu, "does not");
  if (RESTRICTED_EQUALITY.some(pattern => pattern.test(assertion))) return true;
  if (EQUALITY_AFFIRMATION.test(assertion) && !RESTRICTION.test(assertion)) return false;
  return EQUALITY_DISPUTE.some(pattern => pattern.test(assertion)) || feedbackDeniesProvenEquality(assertion);
}

function critiquesInference(text: string | undefined): boolean {
  return text !== undefined && INFERENCE_CRITIQUE.some(pattern => pattern.test(text));
}

function proposalDisputesEquality(context: ProofContext | undefined, incorrectStepCount: number): boolean {
  const feedback = context?.feedback;
  const criteria = context?.criteria?.filter(criterion => criterion.verdict === "incorrect") ?? [];
  if (incorrectStepCount > 1) {
    return criteria.length > 0 ? criteria.every(criterion => disputesEquality(criterion.feedback))
      : disputesEquality(feedback) && !critiquesInference(feedback);
  }
  const feedbackDisputes = disputesEquality(feedback);
  if (!feedbackDisputes && critiquesInference(feedback)) return false;
  let hasDispute = feedbackDisputes;
  for (const criterion of criteria) {
    if (disputesEquality(criterion.feedback)) hasDispute = true;
    else if (critiquesInference(criterion.feedback)) return false;
  }
  return hasDispute;
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
  const incorrectRequired = required.filter(step => step.verdict === "incorrect");
  if (!incorrectRequired.length || !realScalar) return incorrectRequired.length > 0;
  const proposalDispute = proposalDisputesEquality(context, incorrectRequired.length);
  return incorrectRequired.some(step => {
    const disputesStepEquality = disputesEquality(step.feedback) || disputesEquality(step.repairPrompt) ||
      (proposalDispute && !critiquesInference(step.feedback) && !critiquesInference(step.repairPrompt));
    return !disputesStepEquality || !verifyStandaloneProofEquationClaim(step.claim).unconditional;
  });
}
