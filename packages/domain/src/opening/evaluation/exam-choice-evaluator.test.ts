import { describe, expect, it } from "vitest";
import type { ExamChoiceSpec, ExamPack } from "@aistudy/contracts";
import { evaluateExamChoice, parseExamChoiceSpec } from "./exam-choice-evaluator";

const spec: ExamChoiceSpec = {
  kind: "exam_choice", specVersion: "exam-choice-v1", packId: "math-exam", packVersion: "1",
  questionId: "choice-1", familyId: "limit-rational",
};
const pack: ExamPack = {
  id: "math-exam", version: "1", title: "Exam", description: "", topics: [], lessons: [], sourceItems: [], weekPlan: [], limitations: [],
  questions: [{ id: "choice-1", familyId: "limit-rational", topicId: "limits", skillId: "limit", lessonId: "lesson",
    prompt: "Find the limit", pool: "training", difficulty: "foundation", estimatedMinutes: 2,
    options: [{ id: "A", label: "0" }, { id: "B", label: "1" }], answer: "B", explanation: "The answer is 1", hint: "Divide" }],
};

describe("exam choice catalogue evaluation", () => {
  it("grades the exact server-pack option without returning its answer or explanation", () => {
    expect(evaluateExamChoice(spec, pack, "B")).toEqual({ decision: "correct", outcome: "correct", reasonCodes: ["exam_choice_compared"], evaluatorVersion: "exam-choice-exact-v1" });
    expect(evaluateExamChoice(spec, pack, "A")).toMatchObject({ decision: "incorrect", outcome: "incorrect" });
    expect(evaluateExamChoice(spec, pack, "B")).not.toHaveProperty("answer");
    expect(evaluateExamChoice(spec, pack, "B")).not.toHaveProperty("explanation");
    expect(parseExamChoiceSpec(spec)).toEqual(spec);
  });

  it.each([
    { ...spec, answer: "A" }, { ...spec, kind: "matrix_arithmetic" }, { ...spec, specVersion: "exam-choice-v2" },
    { ...spec, packVersion: "" }, { ...spec, familyId: "" }, null, { kind: "exam_choice" },
  ])("abstains on unsupported or answer-bearing specs: %j", raw => {
    expect(parseExamChoiceSpec(raw)).toBeNull();
    expect(evaluateExamChoice(raw, pack, "B")).toMatchObject({ decision: "abstain", outcome: "unverified", reasonCodes: ["missing_or_unsupported_spec"] });
  });

  it.each(["packId", "packVersion", "questionId", "familyId"] as const)("does not grade a mismatched %s", field => {
    expect(evaluateExamChoice({ ...spec, [field]: "other" }, pack, "B")).toMatchObject({ decision: "abstain", outcome: "unverified" });
  });

  it.each(["C", "b", " B ", "1", "B or A", ""])("keeps unrecognized answer %j unverified", answer => {
    expect(evaluateExamChoice(spec, pack, answer)).toMatchObject({ decision: "abstain", outcome: "unverified", reasonCodes: ["invalid_answer_option"] });
  });

  it("abstains when question identity or the frozen reference is ambiguous", () => {
    const question = pack.questions[0]!;
    expect(evaluateExamChoice(spec, { ...pack, questions: [question, question] }, "B").reasonCodes).toEqual(["question_identity_mismatch"]);
    expect(evaluateExamChoice(spec, { ...pack, questions: [{ ...question, answer: "C" }] }, "B").reasonCodes).toEqual(["invalid_reference_options"]);
    expect(evaluateExamChoice(spec, { ...pack, questions: [{ ...question, options: [question.options[0]!, question.options[0]!] }] }, "A").reasonCodes).toEqual(["invalid_reference_options"]);
  });
});
