import { examChoiceSpecSchema, type ExamChoiceSpec, type ExamPack } from "@aistudy/contracts";

export const EXAM_CHOICE_EVALUATOR_VERSION = "exam-choice-exact-v1" as const;
export type ExamChoiceEvaluation = {
  decision: "correct" | "incorrect" | "abstain";
  outcome: "correct" | "incorrect" | "unverified";
  reasonCodes: string[];
  evaluatorVersion: typeof EXAM_CHOICE_EVALUATOR_VERSION;
};

const result = (decision: ExamChoiceEvaluation["decision"], reason: string): ExamChoiceEvaluation => ({
  decision, outcome: decision === "abstain" ? "unverified" : decision,
  reasonCodes: [reason], evaluatorVersion: EXAM_CHOICE_EVALUATOR_VERSION,
});

/** Shape validation cannot establish that a pack belongs to the learner; the repository owns that check. */
export function parseExamChoiceSpec(raw: unknown): ExamChoiceSpec | null {
  const parsed = examChoiceSpecSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The caller supplies the persisted, owner-scoped frozen pack and verifies the
 * captured item stem/options against it. No answer, grading rule, or model verdict
 * is accepted in the spec. This grades one choice, not a complete worked solution.
 */
export function evaluateExamChoice(rawSpec: unknown, pack: ExamPack, answer: string): ExamChoiceEvaluation {
  const spec = parseExamChoiceSpec(rawSpec);
  if (!spec) return result("abstain", "missing_or_unsupported_spec");
  if (pack.id !== spec.packId || pack.version !== spec.packVersion) return result("abstain", "pack_identity_mismatch");
  const matches = pack.questions.filter(question => question.id === spec.questionId);
  const question = matches[0];
  if (matches.length !== 1 || !question) return result("abstain", "question_identity_mismatch");
  if (question.familyId !== spec.familyId) return result("abstain", "question_family_mismatch");
  const optionIds = question.options.map(option => option.id);
  if (optionIds.length < 2 || new Set(optionIds).size !== optionIds.length || !optionIds.includes(question.answer)) {
    return result("abstain", "invalid_reference_options");
  }
  if (!optionIds.includes(answer)) return result("abstain", "invalid_answer_option");
  return result(answer === question.answer ? "correct" : "incorrect", "exam_choice_compared");
}
