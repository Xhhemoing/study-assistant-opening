import type { AiGradingProposal,ProofFeedback } from "@aistudy/contracts";
/** Recognizes explicit task commands only, rather than guessing every proof-shaped answer. */
export function proofFeedbackRequiredByQuestion(stem:string){
  return /(?:^|[，。；：:!?！？\s）).、])(?:请|试)?(?:证明|推导|求证)|\b(?:prove|show\s+that|derive)\b/iu.test(stem);
}
/** Step feedback stays model judgement; contradictory/partial proof claims cannot establish a positive total. */
export function proofFeedbackAllowsOutcome(outcome:AiGradingProposal["outcome"],proof:ProofFeedback|undefined){
  if(!proof)return true;
  if(outcome==="correct")return proof.coverage==="complete"&&proof.steps.some(step=>step.required)&&proof.steps.filter(step=>step.required).every(step=>step.verdict==="correct");
  if(outcome==="incorrect")return proof.steps.some(step=>step.required&&step.verdict==="incorrect");
  return true;
}
