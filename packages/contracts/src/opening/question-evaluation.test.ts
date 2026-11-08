import { describe, expect, it } from "vitest";
import {
  QUESTION_EVALUATION_PROTOCOL,
  questionEvaluationSchema,
  questionPartEvaluationSchema,
  questionUnexposedReceiptSchema,
  retainedQuestionEligibilitySchema,
  type QuestionEvaluation,
} from "./question-evaluation";
import { QUESTION_IDENTITY_PROTOCOL } from "./question-identity";

const id = "12345678-1234-4234-8234-123456789001";
const otherId = "12345678-1234-4234-8234-123456789002";
const part = { partId: "a", requirementKey: "limits", identityRefId: id, outcome: "correct", assistance: "independent" };
const evaluation: QuestionEvaluation = {
  protocolVersion: QUESTION_EVALUATION_PROTOCOL, evaluationRefId: id, questionIdentityRefId: id,
  parts: [
    { ...part, outcome: "correct", assistance: "independent" },
    { ...part, partId: "b", identityRefId: otherId, requirementKey: "continuity", outcome: "incorrect", assistance: "hinted" },
    { ...part, partId: "c", outcome: "unknown", assistance: "unknown" },
  ],
};
const trustedKey = {
  keyRefId: id,
  identity: {
    protocolVersion: QUESTION_IDENTITY_PROTOCOL, identityRefId: id,
    questionRef: { kind: "source_problem", problemId: id, sourceId: id, sourceVersion: 1 },
    sourceRefs: [{ sourceId: id, version: 1 }],
    conditionRefs: [{ kind: "source", sourceId: id, version: 1 }], figureRefs: [], answerRole: "answer_key",
  },
  verification: { kind: "deterministic_evaluator", receiptId: id, evaluatorId: "numeric", evaluatorVersion: "1" },
};
const exposure = {
  workspaceId: id, ownerUserId: otherId, receiptId: id, identityRefId: id,
  historyRevision: 0, checkedAt: "2026-11-08T00:00:00.000Z", status: "unexposed",
};
const ready = { status: "ready", identityStatus: "exact", trustedKey, exposure };

describe("question part evaluation", () => {
  it("preserves each stable requirement/identity mapping and independent part result", () => {
    expect(questionEvaluationSchema.parse(evaluation)).toEqual(evaluation);
    const changed = questionEvaluationSchema.parse({ ...evaluation, parts: evaluation.parts.map((row, index) =>
      index === 1 ? { ...row, outcome: "unknown", assistance: "revealed" } : row) });
    expect(changed.parts[0]).toEqual(evaluation.parts[0]);
    expect(changed.parts[2]).toEqual(evaluation.parts[2]);
  });

  it("allows all correctness/assistance combinations without upgrading assistance", () => {
    for (const outcome of ["correct", "incorrect", "unknown"]) {
      for (const assistance of ["independent", "hinted", "revealed", "unknown"]) {
        expect(questionPartEvaluationSchema.parse({ ...part, outcome, assistance })).toEqual({ ...part, outcome, assistance });
      }
    }
  });

  it("rejects partial as a per-part outcome, missing mappings and whole-question scoring mutations", () => {
    for (const patch of [
      { outcome: "partial" }, { outcome: "unverified" }, { assistance: "none" }, { assistance: undefined },
      { requirementKey: undefined }, { identityRefId: undefined }, { partId: " " },
      { rawAnswer: "42" }, { score: 1 }, { timedScore: 0 }, { browserVerified: true },
    ]) expect(questionPartEvaluationSchema.safeParse({ ...part, ...patch }).success).toBe(false);
    for (const patch of [{ score: 1 }, { wholeQuestionOutcome: "partial" }, { timedScore: 0 }, { protocolVersion: "question-evaluation-2" }]) {
      expect(questionEvaluationSchema.safeParse({ ...evaluation, ...patch }).success).toBe(false);
    }
  });

  it("requires 1..64 parts and rejects duplicate stable IDs (including whitespace variants)", () => {
    const parts = Array.from({ length: 64 }, (_, index) => ({ ...part, partId: `p${index}` }));
    expect(questionEvaluationSchema.safeParse({ ...evaluation, parts }).success).toBe(true);
    for (const invalid of [[], [...parts, { ...part, partId: "overflow" }], [part, part], [part, { ...part, partId: " a " }]]) {
      expect(questionEvaluationSchema.safeParse({ ...evaluation, parts: invalid }).success).toBe(false);
    }
    expect(questionPartEvaluationSchema.safeParse({ ...part, partId: "a".repeat(101) }).success).toBe(false);
    expect(questionPartEvaluationSchema.safeParse({ ...part, requirementKey: "r".repeat(201) }).success).toBe(false);
  });
});

describe("retained question private eligibility", () => {
  it("requires exact identity, trusted key and scoped versioned server unexposed receipt together", () => {
    expect(retainedQuestionEligibilitySchema.parse(ready)).toEqual(ready);
    for (const field of ["identityStatus", "trustedKey", "exposure"]) {
      expect(retainedQuestionEligibilitySchema.safeParse({ ...ready, [field]: undefined }).success).toBe(false);
    }
    for (const identityStatus of ["candidate", "same", "equivalent_exact", "unknown", "conflict"]) {
      expect(retainedQuestionEligibilitySchema.safeParse({ ...ready, identityStatus }).success).toBe(false);
    }
    expect(retainedQuestionEligibilitySchema.safeParse({ ...ready, exposure: { ...exposure, identityRefId: otherId } }).success).toBe(false);
  });

  it("never accepts unknown, client self-certification or incomplete coverage as unseen", () => {
    for (const patch of [
      { status: "unknown" }, { status: "seen" }, { status: "unavailable" },
      { historyRevision: undefined }, { historyRevision: -1 }, { checkedAt: "yesterday" },
      { workspaceId: undefined }, { ownerUserId: undefined }, { receiptId: undefined },
      { clientHash: "abc" }, { browserUnseen: true }, { coverage: "unknown" },
    ]) {
      expect(questionUnexposedReceiptSchema.safeParse({ ...exposure, ...patch }).success).toBe(false);
      expect(retainedQuestionEligibilitySchema.safeParse({ ...ready, exposure: { ...exposure, ...patch } }).success).toBe(false);
    }
    expect(retainedQuestionEligibilitySchema.safeParse({ ...ready, unseen: true }).success).toBe(false);
  });

  it("represents missing/conflicting/exposed evidence explicitly without ready payload or defaults", () => {
    for (const reason of ["identity_unknown", "identity_candidate", "key_unknown", "exposure_unknown", "coverage_unknown"]) {
      const unknown = { status: "unknown", reason };
      expect(retainedQuestionEligibilitySchema.parse(unknown)).toEqual(unknown);
      expect(retainedQuestionEligibilitySchema.safeParse({ ...unknown, exposure }).success).toBe(false);
    }
    for (const reason of ["identity_conflict", "key_unavailable", "reference_unavailable", "exposed", "stale_receipt"]) {
      const unavailable = { status: "unavailable", reason };
      expect(retainedQuestionEligibilitySchema.parse(unavailable)).toEqual(unavailable);
      expect(retainedQuestionEligibilitySchema.safeParse({ ...unavailable, trustedKey }).success).toBe(false);
    }
    expect(retainedQuestionEligibilitySchema.safeParse({}).success).toBe(false);
    expect(retainedQuestionEligibilitySchema.safeParse({ status: "unknown", reason: "unseen" }).success).toBe(false);
  });
});
