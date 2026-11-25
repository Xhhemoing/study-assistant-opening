import type { AiGradingProposal, ProofFeedback } from "@aistudy/contracts";
import {
  assertiveProseSentences, counterfactualProofSteps, feedbackDeniesProvenEquality, ILLUSTRATIVE_PROOF_ROLE,
  independentProseClauses, maskProofQuotations, proofStepUsesRealScalar,
  STEP_ANCHOR, verifyStandaloneProofEquationClaim,
} from "./symbolic-answer-bridge";

type ProofContext = Partial<Pick<AiGradingProposal, "feedback" | "criteria" | "transcription">>;

const MATH_SUBJECT = /(?:equalit(?:y|ies)|identit(?:y|ies)|equations?|expressions?|derivatives?|antiderivatives?|integrals?|expansions?|simplifications?|values?|results?|calculations?|computations?|signs?|coefficients?|constants?|terms?|sides?)/u.source;
const MATH_ERROR = /(?:false|wrong|incorrect|invalid|unequal|mistaken)/u.source;
const GENERALITY = /(?:for\s+all|everywhere|identically|in\s+general|always)/u.source;
const EQUALITY_DISPUTE = [
  new RegExp(String.raw`\b${MATH_SUBJECT}(?:\s+of\s+\w+)?\s+(?:(?:is|are|was|were|looks?|seems?)\s+(?:(?:mathematically|numerically|algebraically)\s+)?${MATH_ERROR}|(?:does|do)\s+not\s+(?:match|hold(?!\s+${GENERALITY}\b)))\b|\b${MATH_ERROR}\s+${MATH_SUBJECT}\b`, "iu"),
  /\b(?:algebra(?:ic)?|arithmeti(?:c|cal)|calculation|computation|differentiation|integration|expansion|factori[sz]ation|factoring|sign)\s+(?:errors?|mistakes?)\b|\bmiscalculat\w*\b(?!\s+nothing\b)|\b(?:missing|omitted)\s+(?:(?:the|a|an|integration|constant|negative|positive)\s+)*(?:constants?|terms?|signs?)\b/iu,
  /等式不成立|恒等式不成立|计算错误|展开错误|化简错误|求导错误|积分错误|代数错误|符号错误|系数错误|漏项/u,
];
const NEGATED_MATH_ERROR = new RegExp(String.raw`\b(?:no|not|without)\s+(?:(?:a|an|any)\s+)?(?:${MATH_ERROR}|(?:(?:algebraic|arithmetic|calculation|computation|differentiation|integration|expansion|factoring|sign)\s+)?(?:errors?|mistakes?))\b`, "giu");
const EQUALITY_AFFIRMATION = /\b(?:equalit(?:y|ies)|identit(?:y|ies)|equations?)\s+(?:holds?\b|(?:is|are)\s+(?:true|correct|valid)\b)|\b(?:both\s+)?sides\s+are\s+equal\b|恒等式成立|等式成立|两边相等/iu;
const EQUALITY_SUBJECT = /(?:equalit(?:y|ies)|identit(?:y|ies)|equations?|expressions?|formulas?)/u.source;
const PROOF_SUBJECT = /\b(?:reasoning|proof|argument|derivation|inference|justification|method|approach|division|cancellation|step)\b/iu;
const HOLDS = /(?:holds?|(?:is|are)\s+(?:true|valid|correct|equal))/u.source;
const ONLY = /(?:only|merely|just|solely)/u.source;
const RESTRICTED_PREDICATE = String.raw`(?:(?:${ONLY}\s+${HOLDS}|${HOLDS}\s+${ONLY})\s+(?:when|if|for|at|on|in)|${HOLDS}\s+(?:except|unless))\b`;
const PRONOUN_RESTRICTION = new RegExp(String.raw`\b(?:it|this)\s+${RESTRICTED_PREDICATE}`, "giu");
const IMPLICIT_DISPUTE = new RegExp(String.raw`^\s*(?:(?:it|this)\s+)?(?:does|do)\s+not\s+(?:match|hold(?!\s+${GENERALITY}\b))\b`, "iu");
const RESTRICTED_EQUALITY = [
  new RegExp(String.raw`\b(?:${EQUALITY_SUBJECT}|sides?)\s+${RESTRICTED_PREDICATE}`, "iu"),
  new RegExp(String.raw`\b${EQUALITY_SUBJECT}\s+(?:(?:${HOLDS}\s+(?:but|and)\s+)?fails?\s+(?:when|if|for|at|outside)|(?:do(?:es)?\s+not\s+hold|(?:is|are)\s+not\s+(?:true|valid|equal))\s+${GENERALITY})\b`, "iu"),
  /\bnot\s+an\s+identity\b/iu,
  /不恒成立|并非恒等式/u,
];
const RESTRICTED_CHINESE_CLAUSE = /[。！？；\r\n]/u;
const CHINESE_MISSING_JUSTIFICATION = /(?:缺少|缺乏|跳过|遗漏|(?:没有|未)(?:给出|提供)?)(?:了|的)?(?:必要|中间|关键)?(?:证明|推导|理由|依据|步骤)/u.source;
const MISSING_JUSTIFICATION = /(?:(?:miss(?:ing|es)?|lack(?:s|ing)?(?:\s+of)?|without|no|skip\w*|omit\w*)\s+(?:(?:the|a|any|an|explicit|necessary|required|intermediate)\s+)*(?:justification|reasoning|proof|derivation|steps?))/u.source;
const DISALLOWED_THEOREM = /(?:disallowed|forbidden|unauthori[sz]ed|not\s+allowed\s+to\s+use)\s+(?:the\s+)?(?:theorem|method|rule)/u.source;
const CHINESE_INFERENCE_DEFECT = String.raw`(?:循环论证|未证先用|直接假设|重述结论|${CHINESE_MISSING_JUSTIFICATION}|未经证明|跳步|除以(?:零|0)|(?:禁止|不能|不得)(?:使用|采用)(?:该|此)?(?:定理|方法))`;
const CIRCULAR_INFERENCE = /(?:circular\s+(?:reasoning|argument|proof)|beg(?:s|ging)?\s+the\s+question|assum\w*\s+(?:(?:the|your)\s+)?(?:conclusion|identity|result|what\s+(?:(?:was|is)\s+to\s+be\s+proved|you\s+(?:had|were\s+asked|need(?:ed)?)\s+to\s+prove))|restat\w*\s+(?:the\s+)?(?:target|conclusion|goal|identity|result))/u.source;
const DOES_NOT_FOLLOW = /(?:do(?:es)?\s+not|doesn['’]t|don['’]t|fail(?:s|ed)?\s+to|cannot|can['’]t)\s+follow/u.source;
const ZERO_DIVISION = /(?:divid(?:e[sd]?|ing)|division)\s+by\s+\$?(?:0|zero)/u.source;
const VARIABLE_DIVISION = /(?:divid(?:e[sd]?|ing)|division)\s+by\s+\$?(?:x|a\s+variable)/u.source;
const ENGLISH_INFERENCE_DEFECT = String.raw`(?:${CIRCULAR_INFERENCE}|${MISSING_JUSTIFICATION}|${DISALLOWED_THEOREM}|${DOES_NOT_FOLLOW}|${ZERO_DIVISION})`;
const INFERENCE_CRITIQUE = [
  new RegExp(String.raw`\b${ENGLISH_INFERENCE_DEFECT}\b`, "iu"),
  new RegExp(CHINESE_INFERENCE_DEFECT, "u"),
];
const DIVIDES_BY_VARIABLE = new RegExp(String.raw`\b${VARIABLE_DIVISION}\b`, "iu");
const DIVISION_DEFECT = /\b(?:without|before)\s+(?:first\s+)?(?:prov|show|establish|justify|check|verify|ensur)\w*\b|\bfails?\s+(?:when|if|for|at|outside)\b/iu;
const NONASSERTED_INFERENCE = /\b(?:whether|(?:wonder|ask|check|verify|test|see|question|consider|determine|examine|inspect)\w*\s+(?:if|whether|for)|what\s+if|if|unless|in\s+case)\b|是否|能否|有无|有没有|如果|若|倘若|除非/iu;
const INFERENCE_DEFECT_REFERENCE = String.raw`(?:${ENGLISH_INFERENCE_DEFECT}|${VARIABLE_DIVISION})`;
const DEFECT_REFUTATION = /(?:false|wrong|incorrect|invalid|mistaken|untrue|baseless|groundless|unfounded|meritless|erroneous|bogus|spurious|misplaced|inaccurate|unproven|unsubstantiated|unsupported|rejected|refuted|disproved)/u.source;
const INFERENCE_DEFECT_DENIAL = String.raw`(?:${DEFECT_REFUTATION}|fails?|collapses?|absent|none|nonexistent|lacking|missing|avoided|eliminated|ruled\s+out|not\s+(?:true|valid|correct|accurate|justified|supported|substantiated|present|found|used|detected|seen|observed|an?\s+(?:issue|concern|problem|defect)|occurring)|(?:(?:does|do|did)\s+not|never|didn['’]t|doesn['’]t)\s+(?:occur|appear|apply|exist|arise|happen)\w*)`;
const CHINESE_DEFECT_DENIAL = /(?:错误的?|有误的?|不正确的?|不实的?|失实的?|虚假的?|站不住脚的?|无稽之谈|毫无根据的?|不成立的?)/u.source;
const CHINESE_DENIAL_PREDICATE = /(?:是(?:错(?:误)?|不对|不准确|不成立|失实|无根据)的|并不(?:属实|成立|正确|准确))/u.source;
const DENIED_CRITIQUE_PREFIX = String.raw`(?:\b(?:it|this|that)\s+(?:is|was|would\s+be|seems?)\s+(?:(?:completely|entirely|wholly|simply|plainly)\s+)?(?:${DEFECT_REFUTATION}|not\s+(?:true|correct|accurate|fair|valid|right|justified))\s+(?:that|to\s+(?:say|claim|suggest|argue|assert|allege|conclude|think))\b|\b(?:cannot|can['’]t|could\s+not|do(?:es)?\s+not|don['’]t|doesn['’]t|should\s+not|shouldn['’]t|must\s+not)\s+(?:(?:fairly|validly|rightly)\s+)?(?:say|claim|suggest|argue|assert|conclude|hold)\s+that\b|\bthere\s+is\s+no\s+(?:truth|basis|merit|grounds?)\s+(?:in|to|for)\s+(?:saying|claiming|the\s+(?:claim|idea|suggestion|view))\b)`;
const DENIED_INFERENCE_CLAUSE = [
  new RegExp(String.raw`${DENIED_CRITIQUE_PREFIX}[^\r\n]*\b${INFERENCE_DEFECT_REFERENCE}\b\$?[^\r\n]*`, "giu"),
  new RegExp(String.raw`(?:并非|并不是|不能说|无法说|不能认为)[^\r\n]*${CHINESE_INFERENCE_DEFECT}[^\r\n]*`, "gu"),
  new RegExp(String.raw`(?:认为|声称|指责|断言|判断|说)[^\r\n]*?${CHINESE_INFERENCE_DEFECT}[^\r\n]*?${CHINESE_DENIAL_PREDICATE}`, "gu"),
  new RegExp(String.raw`(?:^|[，,])[^，,]*${CHINESE_INFERENCE_DEFECT}[^，,]*${CHINESE_DENIAL_PREDICATE}`, "gu"),
];
const NEGATED_INFERENCE_CRITIQUE = [
  new RegExp(String.raw`\b${INFERENCE_DEFECT_REFERENCE}\b\$?(?:[\s,()"“”]+(?!(?:and|or|but|yet|whereas|while|not|never|neither|nor)\b)[\w'’-]+){0,6}[\s,()"“”]+${INFERENCE_DEFECT_DENIAL}\b`, "giu"),
  new RegExp(String.raw`\b${DEFECT_REFUTATION}\s+(?:claims?|accusations?|allegations?|charges?|criticisms?)\s+(?:of|about|that)\s+(?:(?!\b(?:and|or|but|yet)\b)[\w'’-]+\s+){0,6}${INFERENCE_DEFECT_REFERENCE}\b`, "giu"),
  new RegExp(String.raw`${CHINESE_INFERENCE_DEFECT}(?:的?(?:问题|情况|现象|说法|指责|指控|结论|批评|质疑|判断|观点|断言))?\s*(?:并|从来|从|其实|实际上)?(?:不存在|没有(?=\s*(?:$|[，。！？；：,.!?;:)）】]|出现|发生|存在))|未(?:出现|发生|见)|已避免|(?:是|为|纯属|实属|完全是|显然是)?${CHINESE_DEFECT_DENIAL})`, "gu"),
  new RegExp(String.raw`\b(?:no|not|never|neither|nor|without|free\s+of|avoid\w*|[a-z]+n['’]t)\b(?:\s+[\w'’-]+){0,4}\s+${INFERENCE_DEFECT_REFERENCE}\b\$?`, "giu"),
  new RegExp(String.raw`(?:无|没有|并未|并非|不存在|未见|避免(?:了)?|不曾)[^，。！？；：,.!?;:]{0,12}${CHINESE_INFERENCE_DEFECT}`, "gu"),
  new RegExp(String.raw`错误地(?:指责|认为|声称)[^，。！？；：,.!?;:]*?${CHINESE_INFERENCE_DEFECT}`, "gu"),
];

function feedbackAssertionClauses(text: string): string[] {
  return assertiveProseSentences(maskProofQuotations(text)).flatMap(independentProseClauses)
    .filter(clause => !ILLUSTRATIVE_PROOF_ROLE.test(clause));
}

function positiveInferenceClauses(text: string): string[] {
  return feedbackAssertionClauses(text).flatMap(segment => {
    const nonasserted = NONASSERTED_INFERENCE.exec(segment);
    const assertion = DENIED_INFERENCE_CLAUSE.reduce((value, pattern) => value.replace(pattern, " "),
      nonasserted ? segment.slice(0, nonasserted.index) : segment);
    return assertion.split(/\b(?:and|but|yet|while|whereas|though|although|also)\b|而且|并且|(?<!暂)且|同时/iu)
      .map(clause => NEGATED_INFERENCE_CRITIQUE.reduce((value, pattern) => value.replace(pattern, " "), clause));
  });
}

const STEP_PREFIX_END = /(?:[,;:—–，；：](?:\s*(?:in|for|at|see))?|\b(?:and|but|yet|whereas|also|moreover|furthermore)\b|而且|并且|此外)\s*$/iu;
const STEP_LABEL_PUNCTUATION = /^\s*[:：,，—–-]+/u;

function scopeFeedbackToStep(text: string | undefined, stepIndex: number): string | undefined {
  if (!text) return text;
  text = maskProofQuotations(text);
  if (!text.matchAll(STEP_ANCHOR).next().value) return text;
  const applicable: string[] = [];
  for (const sentence of assertiveProseSentences(text)) {
    let start = 0;
    let target: number | undefined;
    for (const anchor of sentence.matchAll(STEP_ANCHOR)) {
      const segment = sentence.slice(start, anchor.index);
      if (target === stepIndex || (target === undefined && STEP_PREFIX_END.test(segment))) {
        applicable.push(segment.replace(STEP_PREFIX_END, "").replace(STEP_LABEL_PUNCTUATION, ""));
      }
      target = Number(anchor[1] ?? anchor[2]);
      start = anchor.index + anchor[0].length;
    }
    if (target === undefined || target === stepIndex) {
      applicable.push(sentence.slice(start).replace(STEP_LABEL_PUNCTUATION, ""));
    }
  }
  return applicable.join("\n").trim() || undefined;
}

function disputesEquality(text: string | undefined, claim: string): boolean {
  if (!text) return false;
  const assertion = feedbackAssertionClauses(text).join("\n")
    .replace(NEGATED_MATH_ERROR, " ").replace(/\b(?:doesn['’]t|don['’]t)\b/giu, "does not");
  const pronoun = assertion.matchAll(PRONOUN_RESTRICTION).next().value;
  if (RESTRICTED_EQUALITY.some(pattern => pattern.test(assertion)) ||
      (pronoun && !PROOF_SUBJECT.test(assertion.slice(0, pronoun.index))) ||
      assertion.split(RESTRICTED_CHINESE_CLAUSE).some(clause => {
        const only = clause.search(/(?:仅|只)(?:在|当)/u);
        const equality = clause.search(/等式|恒等式|两边相等/u);
        return (only !== -1 && clause.indexOf("成立", only) !== -1) ||
          (equality !== -1 && clause.indexOf("除非", equality) !== -1);
      })) return true;
  if (EQUALITY_AFFIRMATION.test(assertion)) return false;
  return IMPLICIT_DISPUTE.test(assertion) || EQUALITY_DISPUTE.some(pattern => pattern.test(assertion)) ||
    feedbackDeniesProvenEquality(assertion, claim);
}

function critiquesInference(text: string | undefined): boolean {
  return text !== undefined && (INFERENCE_CRITIQUE.some(pattern => pattern.test(text)) ||
    (DIVIDES_BY_VARIABLE.test(text) && DIVISION_DEFECT.test(text)));
}

function hasIndependentInferenceCritique(text: string | undefined, claim: string): boolean {
  if (!text) return false;
  return positiveInferenceClauses(text).some(clause => critiquesInference(clause) && !disputesEquality(clause, claim));
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
  const stepUsesRealScalar = proofStepUsesRealScalar(proof.steps, context?.transcription, [
    context?.feedback,
    ...context?.criteria?.flatMap(criterion => [criterion.label, criterion.feedback]) ?? [],
  ]);
  if (outcome === "correct") {
    if (proof.coverage !== "complete" || !required.length || required.some(step => step.verdict !== "correct")) return false;
    const counterfactual = counterfactualProofSteps(proof.steps);
    return required.every(step => !stepUsesRealScalar.get(step) || counterfactual.has(step) ||
      verifyStandaloneProofEquationClaim(step.claim).status !== "inequivalent");
  }
  const incorrectRequired = required.filter(step => step.verdict === "incorrect");
  const incorrectCriteria = context?.criteria?.filter(criterion => criterion.verdict === "incorrect") ?? [];
  return incorrectRequired.some(step => {
    const { claim, feedback, repairPrompt } = step;
    if (!stepUsesRealScalar.get(step) || !verifyStandaloneProofEquationClaim(claim).unconditional) return true;
    const proposalFeedback = scopeFeedbackToStep(context?.feedback, step.stepIndex);
    const criteriaFeedback = incorrectCriteria.flatMap(criterion => {
      const otherStep = [...criterion.label.matchAll(STEP_ANCHOR)]
        .some(anchor => Number(anchor[1] ?? anchor[2]) !== step.stepIndex);
      if (otherStep) return [];
      const scoped = scopeFeedbackToStep(criterion.feedback, step.stepIndex);
      return scoped ? [scoped] : [];
    });
    if ([feedback, repairPrompt, proposalFeedback, ...criteriaFeedback]
      .some(text => hasIndependentInferenceCritique(text, claim))) return true;
    if (disputesEquality(feedback, claim) || disputesEquality(repairPrompt, claim)) return false;
    const criterionDisputes = criteriaFeedback.map(text => disputesEquality(text, claim));
    const proposalDisputes = disputesEquality(proposalFeedback, claim);
    return incorrectRequired.length > 1 && criterionDisputes.length > 0
      ? !criterionDisputes.every(Boolean)
      : !proposalDisputes && !criterionDisputes.some(Boolean);
  });
}
