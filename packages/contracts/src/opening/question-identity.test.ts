import { describe, expect, it } from "vitest";
import {
  QUESTION_IDENTITY_PROTOCOL,
  privateTrustedQuestionKeySchema,
  questionContentRefSchema,
  questionIdentityMatchSchema,
  questionIdentitySchema,
  questionRefSchema,
  questionSourceRefSchema,
  type QuestionIdentity,
} from "./question-identity";
import { teachingSourceRefSchema } from "./teaching-content";

const id = "12345678-1234-4234-8234-123456789001";
const otherId = "12345678-1234-4234-8234-123456789002";
const source = { sourceId: id, version: 0, page: 1 };
const block = { kind: "block" as const, documentId: id, revisionNumber: 1, blockId: otherId };
const identity: QuestionIdentity = {
  protocolVersion: QUESTION_IDENTITY_PROTOCOL,
  identityRefId: id,
  questionRef: { kind: "source_problem", problemId: id, sourceId: id, sourceVersion: 0 },
  sourceRefs: [source], conditionRefs: [{ kind: "source", ...source }], figureRefs: [block],
  answerRole: "answer_key",
};
const receipt = {
  receiptId: id, method: "server_exact", comparatorVersion: "exact-1",
  conditions: "exact", figures: "exact", answerRole: "exact",
};
const match = { protocolVersion: QUESTION_IDENTITY_PROTOCOL, leftIdentityRefId: id, rightIdentityRefId: otherId };
const verification = { kind: "deterministic_evaluator", receiptId: id, evaluatorId: "numeric", evaluatorVersion: "1" };

describe("question identity references", () => {
  it("reuses teaching source refs while requiring a pinned numeric source version", () => {
    const parsed = questionSourceRefSchema.parse(source);
    expect(teachingSourceRefSchema.parse(parsed)).toEqual(source);
    for (const version of [undefined, null, "0", -1, 1.5, Infinity]) {
      expect(questionSourceRefSchema.safeParse({ ...source, version }).success).toBe(false);
    }
  });

  it("supports source problems, revision-pinned teaching blocks and non-UUID exam IDs", () => {
    expect(questionIdentitySchema.parse(identity)).toEqual(identity);
    expect(questionContentRefSchema.parse(block)).toEqual(block);
    const teaching = {
      kind: "teaching_question", activityId: id, documentId: id, revisionNumber: 1,
      contentVersion: 0, questionBlockId: id, answerBlockId: otherId,
    };
    expect(questionIdentitySchema.safeParse({ ...identity, questionRef: teaching }).success).toBe(true);
    expect(questionRefSchema.parse({
      kind: "exam_question", packId: "midterm", packVersion: "v1", questionId: "q-1", familyId: "limits",
    }).kind).toBe("exam_question");
    expect(questionIdentitySchema.safeParse({ ...identity, figureRefs: [] }).success).toBe(true);
  });

  it("rejects missing exact anchors, answer-role conflicts and unpinned revisions", () => {
    for (const patch of [
      { sourceRefs: [] }, { conditionRefs: [] }, { answerRole: "prompt" },
      { protocolVersion: "question-identity-2" },
      { sourceRefs: [{ ...source, version: 1 }] },
      { questionRef: { ...identity.questionRef, sourceVersion: -1 } },
      { conditionRefs: [{ ...block, revisionNumber: 0 }] },
      { figureRefs: [{ ...block, revisionNumber: undefined }] },
      { questionRef: { kind: "teaching_question", activityId: id, documentId: id,
        revisionNumber: 1, contentVersion: 0, questionBlockId: id, answerBlockId: id } },
    ]) expect(questionIdentitySchema.safeParse({ ...identity, ...patch }).success).toBe(false);
  });

  it("bounds every identity reference array and rejects raw/client claims at nested boundaries", () => {
    for (const [field, row, max] of [
      ["sourceRefs", source, 32], ["conditionRefs", block, 64], ["figureRefs", block, 32],
    ] as const) {
      expect(questionIdentitySchema.safeParse({ ...identity, [field]: Array.from({ length: max }, () => row) }).success).toBe(true);
      expect(questionIdentitySchema.safeParse({ ...identity, [field]: Array.from({ length: max + 1 }, () => row) }).success).toBe(false);
    }
    for (const patch of [
      { clientHash: "abc" }, { rawAnswer: "42" }, { browserVerified: true },
      { sourceRefs: [{ ...source, answer: "42" }] },
      { conditionRefs: [{ ...block, text: "condition" }] },
      { questionRef: { ...identity.questionRef, fingerprint: "client" } },
    ]) expect(questionIdentitySchema.safeParse({ ...identity, ...patch }).success).toBe(false);
  });
});

describe("exact comparison versus semantic candidates", () => {
  it.each(["same", "equivalent_exact"])("requires a complete server exact receipt for %s", kind => {
    expect(questionIdentityMatchSchema.safeParse({ ...match, result: { kind, receipt } }).success).toBe(true);
    for (const result of [
      { kind }, { kind, clientHash: "abc" },
      { kind, receipt: { ...receipt, method: "semantic" } },
      { kind, receipt: { ...receipt, figures: "unknown" } },
      { kind, receipt: { ...receipt, answerRole: undefined } },
      { kind, receipt: { ...receipt, rawAnswer: "42" } },
    ]) expect(questionIdentityMatchSchema.safeParse({ ...match, result }).success).toBe(false);
  });

  it("keeps candidate/unknown/conflict distinct, with no dedupe/unseen or stronger evidence fields", () => {
    for (const result of [
      { kind: "candidate", basis: "semantic" },
      { kind: "candidate", basis: "model" },
      { kind: "unknown", reason: "missing_figures" },
      { kind: "conflict", dimensions: ["conditions", "answer_role"] },
    ]) {
      expect(questionIdentityMatchSchema.safeParse({ ...match, result }).success).toBe(true);
      for (const claim of [{ receipt }, { deduplicate: true }, { unseen: true }, { verifiedKey: true }]) {
        expect(questionIdentityMatchSchema.safeParse({ ...match, result: { ...result, ...claim } }).success).toBe(false);
      }
    }
    expect(questionIdentityMatchSchema.safeParse({ ...match, result: { kind: "conflict", dimensions: [] } }).success).toBe(false);
    expect(questionIdentityMatchSchema.safeParse({ ...match, result: { kind: "conflict", dimensions: Array(5).fill("figures") } }).success).toBe(false);
    expect(questionIdentityMatchSchema.safeParse({ ...match, result: { kind: "matched" } }).success).toBe(false);
  });
});

describe("private immutable trusted key descriptor", () => {
  it("accepts only deterministic evaluator or independent family verification references", () => {
    for (const verified of [verification, {
      kind: "independent_family", receiptId: otherId, familyId: "limits", verifierId: "reviewer", verifierVersion: "1",
    }]) {
      expect(privateTrustedQuestionKeySchema.safeParse({ keyRefId: id, identity, verification: verified }).success).toBe(true);
    }
    for (const invalid of [
      { kind: "matched", receiptId: id }, { kind: "model_answer", receiptId: id },
      { ...verification, receiptId: undefined }, { ...verification, evaluatorVersion: "" },
    ]) expect(privateTrustedQuestionKeySchema.safeParse({ keyRefId: id, identity, verification: invalid }).success).toBe(false);
  });

  it("rejects a family receipt bound to a different exam family", () => {
    const key = { keyRefId: id, identity: { ...identity, questionRef: {
      kind: "exam_question", packId: "midterm", packVersion: "v1", questionId: "q1", familyId: "limits",
    } }, verification: {
      kind: "independent_family", receiptId: id, familyId: "continuity", verifierId: "reviewer", verifierVersion: "1",
    } };
    expect(privateTrustedQuestionKeySchema.safeParse(key).success).toBe(false);
    expect(privateTrustedQuestionKeySchema.safeParse({ ...key,
      verification: { ...key.verification, familyId: "limits" } }).success).toBe(true);
  });

  it("does not accept plaintext keys, hashes, browser fields or a match substituted for exact identity", () => {
    const key = { keyRefId: id, identity, verification };
    for (const patch of [
      { answer: "42" }, { answerRule: { type: "exact", accepted: ["42"] } },
      { clientHash: "abc" }, { browserVerified: true }, { identity: match },
    ]) expect(privateTrustedQuestionKeySchema.safeParse({ ...key, ...patch }).success).toBe(false);
  });
});
