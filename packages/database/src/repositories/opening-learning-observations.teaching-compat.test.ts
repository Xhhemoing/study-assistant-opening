import { beforeEach, expect, it, vi } from "vitest";
import type { TransactionSql } from "postgres";
import { serverEvaluationSchema } from "@aistudy/contracts";
import { captureNextLearningStep, NEXT_LEARNING_STEP_VERSION } from "@aistudy/domain";
import { qualifiedInput } from "../../../domain/src/opening/learning-summary-fixtures";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { insertOpeningLearningObservationInTx } from "./opening-learning-observations";
import { evaluateOpeningTeachingKeyAttempt } from "./opening-teaching-question-evaluation";
import { evaluateOpeningExamAttempt } from "./opening-exam-integration-evaluation";
import { evaluateOpeningSpanAttempt } from "./opening-span-evaluation";
import { evaluateOpeningMatrixAttempt } from "./opening-matrix-evaluation";
import { spanTutorReceiptDecision, SPAN_TUTOR_EXECUTION_POLICY_VERSION } from "./opening-span-tutor-context";

vi.mock("./opening-teaching-question-evaluation", () => ({ evaluateOpeningTeachingKeyAttempt: vi.fn() }));
vi.mock("./opening-exam-integration-evaluation", () => ({ evaluateOpeningExamAttempt: vi.fn() }));
vi.mock("./opening-span-evaluation", () => ({ evaluateOpeningSpanAttempt: vi.fn() }));
vi.mock("./opening-matrix-evaluation", () => ({ evaluateOpeningMatrixAttempt: vi.fn() }));
vi.mock("./opening-learning-facts", async original => ({ ...await original<typeof import("./opening-learning-facts")>(),
  lockWorkspaceLearningHistory: vi.fn(), lockLearningHistory: vi.fn(),
  lockLearningSession: vi.fn(async () => ({ course_id: "course", skill_label: "skill", source_ids: [], activity_id: "activity" })),
  admitLearningSources: vi.fn(async () => []),
}));
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
beforeEach(() => vi.clearAllMocks());

it.each(["teaching", "exam", "span", "matrix"])("restores teaching evaluation after the %s dispatch without bypassing exam/span/matrix", async kind => {
  const controlled = { evaluatorVersion: "fixture", specVersion: "fixture", decision: "correct", outcome: "correct", reasonCodes: ["match"] };
  vi.mocked(evaluateOpeningExamAttempt).mockResolvedValue(kind === "exam" ? controlled as never : null);
  vi.mocked(evaluateOpeningSpanAttempt).mockResolvedValue(kind === "span" ? controlled as never : null);
  vi.mocked(evaluateOpeningMatrixAttempt).mockResolvedValue(kind === "matrix" ? controlled as never : null);
  vi.mocked(evaluateOpeningTeachingKeyAttempt).mockResolvedValue(kind === "teaching" ? controlled as never : null);
  const queries: string[] = [];
  const tx = vi.fn(async (parts: TemplateStringsArray) => {
    const query = parts.join("?"); queries.push(query);
    if (query.includes("SELECT * FROM opening_learning_attempts")) return [{ id: "attempt", session_id: "session", course_id: "course",
      source_ids: [], problem_id: "problem", create_intent: { teachingBlock: { contentVersion: 1 } } }];
    if (query.includes("SELECT status,content_version")) return [{ status: "active", content_version: 1 }];
    if (query.includes("clock_timestamp()")) throw new Error("stop before writes");
    return [];
  });
  await expect(insertOpeningLearningObservationInTx(tx as unknown as TransactionSql, scope, {
    sessionId: "session", courseId: "course", skillLabel: "skill", sourceIds: [], attemptId: "attempt", problemId: "problem",
    answer: "2", outcome: "unverified", assistance: "independent", clientKey: "new-key",
  })).rejects.toThrow("stop before writes");
  expect(evaluateOpeningTeachingKeyAttempt).toHaveBeenCalledTimes(kind === "teaching" ? 1 : 0);
  expect(evaluateOpeningExamAttempt).toHaveBeenCalledOnce();
  expect(evaluateOpeningSpanAttempt).toHaveBeenCalledTimes(kind === "exam" ? 0 : 1);
  expect(evaluateOpeningMatrixAttempt).toHaveBeenCalledTimes(kind === "exam" || kind === "span" ? 0 : 1);
  expect(queries.some(query => /^\s*(?:INSERT|UPDATE|DELETE)\b/.test(query))).toBe(false);
});

const id = "00000000-0000-4000-8000-000000000001";
const receipt = { observationId: id, attemptId: id, problemId: id, itemVersionId: id, requirementKey: "teaching:fixture",
  evaluatorVersion: "teaching-key-exact-v1", specVersion: "teaching-key-v1", decision: "correct", outcome: "correct",
  reasonCodes: ["teaching_key_match"], evaluatedAt: "2026-11-06T00:00:00Z" };
it.each(["correct", "incorrect", "abstain"] as const)("strictly reads historical teaching %s without granting unknown authority", decision => {
  const parsed = serverEvaluationSchema.parse({ ...receipt, decision, outcome: decision === "abstain" ? "unverified" : decision });
  const observation = { ...qualifiedInput.observation, observationId: id, attemptId: id, problemId: id, itemVersionId: id,
    requirementKey: receipt.requirementKey, verdictSource: "deterministic" as const, outcome: parsed.outcome };
  const context = { ...qualifiedInput.context, serverEvaluation: parsed, version: { applicability: "exact" as const, currentItemVersionId: id } };
  expect(evaluateEvidenceEligibility(observation, context).verifiedCorrect).toBe(decision === "correct" ? "yes" : decision === "incorrect" ? "no" : "unknown");
  expect(evaluateEvidenceEligibility(observation, { ...context, serverEvaluation: { ...parsed, attemptId: "foreign" } }).verifiedCorrect).toBe("unknown");
  expect(evaluateEvidenceEligibility(observation, { ...context, version: { applicability: "unavailable" } }).usableForCurrentVersion).not.toBe("yes");
  expect(serverEvaluationSchema.safeParse({ ...parsed, specVersion: "unknown" }).success).toBe(false);
  expect(serverEvaluationSchema.safeParse({ ...parsed, secret: true }).success).toBe(false);
});

it.each(["next-learning-step-1/span-tutor-execution-1", "next-learning-step-2/span-tutor-execution-2", "next-learning-step-3/span-tutor-execution-2", "next-learning-step-4/span-tutor-execution-2", "next-learning-step-5/span-tutor-execution-2", "next-learning-step-6/span-tutor-execution-2"])(
  "reads %s including the saved v3 decision without selecting it anew", policyVersion => {
    const ruleDecision = { activityKind: "reduced_help_practice", focusObservationId: null, reasonCode: "assisted_success" };
    expect(spanTutorReceiptDecision({ policyVersion, intentVersion: JSON.stringify({ ruleDecision }) })).toEqual(ruleDecision);
  });
it("combines restored assisted success and D4 under v6 and rejects unknown policy combinations", () => {
  expect(NEXT_LEARNING_STEP_VERSION).toBe("next-learning-step-6");
  expect(SPAN_TUTOR_EXECUTION_POLICY_VERSION).toBe("next-learning-step-6/span-tutor-execution-2");
  const capture = captureNextLearningStep({ observations: [], wantsFullExplanation: false });
  expect(capture.decision.reasonCode).toBe("no_evidence");
  const assisted = captureNextLearningStep({ wantsFullExplanation: false, observations: [
    { id: "helped", skillLabel: "skill", attemptedAt: "2026-11-06T00:00:00Z", assistance: "hinted",
      verifiedCorrect: "yes", independentAttempt: "no", usableForCurrentVersion: "yes", problemId: null },
    { id: "prior", skillLabel: "skill", attemptedAt: "2026-11-05T00:00:00Z", assistance: "independent",
      verifiedCorrect: "yes", independentAttempt: "yes", usableForCurrentVersion: "yes", problemId: null },
  ] });
  expect(assisted.decision).toMatchObject({ activityKind: "reduced_help_practice", reasonCode: "assisted_success" });
  expect(assisted.candidates.at(-1)).toMatchObject({ eligible: true, reasonCodes: ["assisted_success"] });
  for (const policyVersion of ["next-learning-step-3/span-tutor-execution-1", "next-learning-step-7/span-tutor-execution-2", "next-learning-step-5/span-tutor-execution-3"]) {
    expect(spanTutorReceiptDecision({ policyVersion, intentVersion: "not JSON" })).toBeNull();
  }
});
