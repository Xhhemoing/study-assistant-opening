import { describe, expect, it } from "vitest";
import type { AiEvaluation } from "@aistudy/contracts";
import { aiGradingProposalSchema, proofFeedbackSchema, teachingLearnerFocusSchema } from "@aistudy/contracts";
import { acceptedAiGradingOutcome } from "./ai-evaluation";
import { proofFeedbackAllowsOutcome, proofFeedbackRequiredByQuestion } from "./proof-feedback";
import { toSnapshotEvidence } from "./adaptive/snapshot-evidence";
import { buildDecisionInput } from "./adaptive/decision-input";
import { nextLearningStep } from "./adaptive/next-learning-step";
import { courseEvidence, learningObservation, qualifiedInput } from "./learning-summary-fixtures";
import { normalizeSkillLabelKey, adaptiveSkillIdentity } from "./adaptive/skill-identity";

const id = learningObservation.id;
const step = { stepIndex: 1, claim: "两边同乘非零常数", required: true, verdict: "correct" as const,
  feedback: "等价变形", repairPrompt: "核对非零条件" };
const evaluation: AiEvaluation = {
  observationId: id, attemptId: qualifiedInput.observation.attemptId!, problemId: qualifiedInput.observation.problemId!,
  itemVersionId: qualifiedInput.observation.itemVersionId!, requirementKey: qualifiedInput.observation.requirementKey!,
  evaluatorVersion: "ai-rubric-v1", outcome: "incorrect", confidence: 0.9, questionMatch: true,
  feedback: "先核对除数", criteria: [{ label: "除法", verdict: "incorrect", feedback: "不能除以零" }],
  modelLabel: null, evaluatedAt: "2026-10-21T08:00:00Z",
};
function aiEvidence(change: Partial<AiEvaluation> = {}) {
  const assessment = { ...evaluation, ...change };
  const facts = { observation: { ...qualifiedInput.observation, observationId: id, verdictSource: "ai_graded" as const, outcome: "incorrect" as const },
    context: { ...qualifiedInput.context, aiEvaluation: assessment } };
  const evidence = courseEvidence(facts);
  evidence.observations[0] = { ...learningObservation, outcome: "incorrect", verdictSource: "ai_graded", aiEvaluation: assessment };
  return { evidence, facts, assessment };
}
function errors(change: Partial<AiEvaluation> = {}) {
  return toSnapshotEvidence(aiEvidence(change).evidence, new Date("2026-10-22T00:00:00Z")).observations[0]!.errors;
}

describe("proof judgement is not a binary correctness authority", () => {
  it.each([
    ["complete", "correct", true, true], ["complete", "incorrect", true, false],
    ["complete", "unverified", true, false], ["partial", "correct", true, false],
    ["unreadable", "correct", true, false], ["complete", "correct", false, false],
  ] as const)("positive total: coverage=%s verdict=%s required=%s", (coverage, verdict, required, accepted) => {
    expect(proofFeedbackAllowsOutcome("correct", { coverage, steps: [{ ...step, verdict, required }] })).toBe(accepted);
  });
  it.each([
    ["incorrect", true, true], ["incorrect", false, false], ["unverified", true, false], ["correct", true, false],
  ] as const)("negative total needs a required incorrect step: %s/%s", (verdict, required, accepted) => {
    expect(proofFeedbackAllowsOutcome("incorrect", { coverage: "partial", steps: [{ ...step, verdict, required }] })).toBe(accepted);
  });
  it("an optional wrong step does not contradict an otherwise complete required proof", () => {
    expect(proofFeedbackAllowsOutcome("correct", { coverage: "complete", steps: [step, { ...step, stepIndex: 2, required: false, verdict: "incorrect" }] })).toBe(true);
  });
  it("an optional wrong step cannot justify an incorrect total", () => {
    expect(proofFeedbackAllowsOutcome("incorrect", { coverage: "complete", steps: [step, { ...step, stepIndex: 2, required: false, verdict: "incorrect" }] })).toBe(false);
  });
  it("partial feedback cannot establish a correct total even at confidence 1", () => {
    expect(acceptedAiGradingOutcome({ ...evaluation, outcome: "correct", confidence: 1,
      criteria: [{ label: "结论", verdict: "correct", feedback: "结果相同" }], proofFeedback: { coverage: "partial", steps: [step] } })).toBe("unverified");
  });
  it.each(["证明 $a=b$", "请推导下一行", "(2)证明这个结论", "Show that A is invertible", "derive the identity"])("explicit command %s", stem => {
    expect(proofFeedbackRequiredByQuestion(stem)).toBe(true);
  });
  it.each(["解释证明的含义", "无需证明，写结果", "计算下一步", "improve the estimate", "showcase the diagram"])("not a proof command %s", stem => {
    expect(proofFeedbackRequiredByQuestion(stem)).toBe(false);
  });
});

describe("persisted proof/model fields reject wrong types and incomplete shapes", () => {
  it.each([
    ["null", null], ["array", []], ["missing coverage", { steps: [step] }], ["missing steps", { coverage: "complete" }],
    ["empty steps", { coverage: "complete", steps: [] }], ["duplicate indices", { coverage: "complete", steps: [step, step] }],
    ["string index", { coverage: "complete", steps: [{ ...step, stepIndex: "1" }] }],
    ["zero index", { coverage: "complete", steps: [{ ...step, stepIndex: 0 }] }],
    ["index beyond bound", { coverage: "complete", steps: [{ ...step, stepIndex: 101 }] }],
    ["blank repair", { coverage: "complete", steps: [{ ...step, repairPrompt: " " }] }],
    ["wrong required", { coverage: "complete", steps: [{ ...step, required: "true" }] }],
    ["unknown verdict", { coverage: "complete", steps: [{ ...step, verdict: "maybe" }] }],
    ["reserved payload", { coverage: "complete", steps: [step], reservedQuestion: "PRIVATE_SENTINEL" }],
  ])("proof contract: %s", (_name, value) => expect(proofFeedbackSchema.safeParse(value).success).toBe(false));
  it("accepts unordered unique step numbers without pretending to sort them", () => {
    expect(proofFeedbackSchema.parse({ coverage: "partial", steps: [{ ...step, stepIndex: 9 }, step] }).steps.map(item => item.stepIndex)).toEqual([9, 1]);
  });
  it.each([
    ["numeric confidence", { confidence: "0.9" }], ["null confidence", { confidence: null }],
    ["infinite confidence", { confidence: Infinity }], ["missing question match", { questionMatch: undefined }],
    ["empty criteria", { criteria: [] }], ["null proof", { proofFeedback: null }],
    ["reserved answer", { reservedAnswer: "PRIVATE_SENTINEL" }],
  ])("proposal contract: %s", (_name, patch) => {
    const { observationId: _o, attemptId: _a, problemId: _p, itemVersionId: _i, requirementKey: _r,
      evaluatorVersion: _e, modelLabel: _m, evaluatedAt: _t, ...proposal } = evaluation;
    expect(aiGradingProposalSchema.safeParse({ ...proposal, ...patch }).success).toBe(false);
  });
});

describe("current accepted AI error projection remains model feedback", () => {
  it("preserves an accepted negative criterion while keeping correctness unknown", () => {
    const mapped = toSnapshotEvidence(aiEvidence().evidence, new Date());
    expect(mapped.observations[0]).toMatchObject({ verifiedCorrect: "unknown", errors: [
      { observationId: id, label: "除法", feedback: "不能除以零", source: "ai_feedback" },
    ] });
    expect(nextLearningStep(buildDecisionInput({ observations: mapped.observations, wantsFullExplanation: false })))
      .toMatchObject({ activityKind: "diagnose", focusObservationId: null });
  });
  it.each([
    ["confidence below boundary", { confidence: 0.799999 }], ["question mismatch", { questionMatch: false }],
    ["abstained", { outcome: "unverified" }], ["other observation", { observationId: "other" }],
    ["other attempt", { attemptId: "other" }], ["other problem", { problemId: "other" }],
    ["other item revision", { itemVersionId: "other" }], ["other requirement", { requirementKey: "other" }],
    ["inconsistent criteria", { criteria: [{ label: "结论", verdict: "correct", feedback: "相符" }] }],
  ] as const)("no errors from %s", (_name, patch) => expect(errors(patch as Partial<AiEvaluation>)).toBeUndefined());
  it.each(["changed_needs_check", "unavailable", "privacy_excluded"] as const)("no errors from material applicability %s", applicability => {
    const { evidence, facts } = aiEvidence(); facts.context.version = { applicability };
    expect(toSnapshotEvidence(evidence, new Date()).observations[0]!.errors).toBeUndefined();
  });
  it.each([undefined, null, "other"])("does not elevate missing/generic misconception %s", misconceptionId => {
    expect(errors({ misconceptionId })?.[0]).not.toHaveProperty("misconceptionId");
  });
  it("keeps named misconception attached to the original observation", () => {
    expect(errors({ misconceptionId: "divide_by_zero" })?.[0]).toMatchObject({ observationId: id, misconceptionId: "divide_by_zero", source: "ai_feedback" });
  });
  it("limits incorrect criteria, skips positive criteria and truncates each boundary field", () => {
    const criteria = [{ label: "valid", verdict: "correct" as const, feedback: "ok" }, ...[1,2,3,4].map(n => ({ label: String(n)+"x".repeat(300), verdict: "incorrect" as const, feedback: "y".repeat(1200) }))];
    const result = errors({ criteria })!;
    expect(result).toHaveLength(3); expect(result.map(item => item.label[0])).toEqual(["1", "2", "3"]);
    expect(result.every(item => item.label.length === 200 && item.feedback.length === 1000)).toBe(true);
  });
});

describe("label aliases preserve scope, not merely spelling", () => {
  it.each([
    [" ＬＩＮＥＡＲ　ＡＬＧＥＢＲＡ ", "linearalgebra"], ["Linear\nAlgebra", "linearalgebra"],
    ["分数\t加法", "分数加法"], ["① 次式", "1次式"], ["K", "k"], ["Ａ²", "a2"],
    ["e\u0301", "é"], ["É", "é"], ["a\u00a0b", "ab"], ["\u2003", ""],
  ])("normalize %s", (input, expected) => expect(normalizeSkillLabelKey(input)).toBe(expected));
  it.each([["calc", "prove"], [null, "calc"], [undefined, "calc"], ["", null], ["a:b", "a"]])("requirements %s/%s stay distinct", (a, b) => {
    expect(adaptiveSkillIdentity("x", a)).not.toBe(adaptiveSkillIdentity("x", b));
  });
  it("legacy omitted and explicit-null requirement share only the unassigned identity", () => {
    expect(adaptiveSkillIdentity("x", undefined)).toBe(adaptiveSkillIdentity("x", null));
  });
  it("does not remove punctuation or zero-width characters to invent identity equivalence", () => {
    expect(normalizeSkillLabelKey("a-b")).not.toBe(normalizeSkillLabelKey("ab"));
    expect(normalizeSkillLabelKey("a\u200bb")).not.toBe(normalizeSkillLabelKey("ab"));
  });
});

describe("learner-focus persisted trust boundary", () => {
  const focus = { skillLabel: "fractions", activityKind: "diagnose", reasonCode: "unverified_only", focusObservationId: null,
    recentAssistance: [], strategyVersion: "adaptive-1" };
  it.each([
    ["null skill", { skillLabel: null }], ["number skill", { skillLabel: 1 }], ["empty skill", { skillLabel: "" }],
    ["missing observation", { focusObservationId: undefined }], ["invalid observation", { focusObservationId: "missing" }],
    ["null assistance", { recentAssistance: null }], ["too many assists", { recentAssistance: Array(4).fill("hinted") }],
    ["wrong activity", { activityKind: "mastered" }], ["reserved payload", { reservedQuestion: "PRIVATE_SENTINEL" }],
    ["answer leak", { answerKey: "PRIVATE_SENTINEL" }], ["wrong recentErrors", { recentErrors: {} }],
    ["too many errors", { recentErrors: Array(4).fill({ observationId: id, label: "x", feedback: "y", source: "ai_feedback" }) }],
    ["error claims authority", { recentErrors: [{ observationId: id, label: "x", feedback: "y", source: "verified" }] }],
    ["nested reserved leak", { recentErrors: [{ observationId: id, label: "x", feedback: "y", source: "ai_feedback", reservedAnswer: "PRIVATE_SENTINEL" }] }],
  ])("rejects %s", (_name, patch) => expect(teachingLearnerFocusSchema.safeParse({ ...focus, ...patch }).success).toBe(false));
  it.each([undefined, null, "", "requirement-1"])("keeps requirement contract literal: %s", requirementKey => {
    const result = teachingLearnerFocusSchema.parse({ ...focus, ...(requirementKey === undefined ? {} : { requirementKey }) });
    expect(result.requirementKey).toBe(requirementKey);
  });
});
