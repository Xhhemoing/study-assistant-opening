import { describe, expect, it } from "vitest";
import { compareCourseQuestionIdentity, type ResolvedCourseQuestion } from "./course-question-identity";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function question(): ResolvedCourseQuestion {
  return { identity: { protocolVersion: "question-identity-1", identityRefId: id(1),
    questionRef: { kind: "teaching_question", activityId: id(2), documentId: id(3), revisionNumber: 1, contentVersion: 1,
      questionBlockId: id(4), answerBlockId: id(5) }, sourceRefs: [{ sourceId: id(6), version: 1 }],
    conditionRefs: [{ kind: "block", documentId: id(3), revisionNumber: 1, blockId: id(4) }], figureRefs: [], answerRole: "answer_key" },
    conditions: "Calculate 1+1", interaction: { kind: "numeric" }, answer: "2" };
}
describe("private exact question identity", () => {
  it("ignores registry/prompt/document UUID renaming only after content and immutable versions resolve", () => {
    const left = question(), right = question();
    expect(compareCourseQuestionIdentity(left, right)).toBe("same");
    right.identity.identityRefId = id(7);
    right.identity.questionRef = { ...right.identity.questionRef as Extract<typeof right.identity.questionRef, { kind: "teaching_question" }>,
      activityId: id(8), documentId: id(9), questionBlockId: id(10), answerBlockId: id(11) };
    right.identity.conditionRefs = [{ kind: "block", documentId: id(9), revisionNumber: 1, blockId: id(10) }];
    expect(compareCourseQuestionIdentity(left, right)).toBe("equivalent_exact");
  });
  it.each(["conditions", "units", "figures", "version", "revision", "source", "answer"])("does not deduplicate changed %s", dimension => {
    const left = question(), right = question();
    if (dimension === "conditions") right.conditions += " with x>0";
    if (dimension === "units") right.interaction = { kind: "numeric", unit: "m" };
    if (dimension === "figures") right.identity.figureRefs = [{ kind: "source", sourceId: id(6), version: 1, page: 2 }];
    if (dimension === "source") right.identity.sourceRefs[0]!.version = 2;
    if (dimension === "answer") right.answer = "3";
    if (right.identity.questionRef.kind === "teaching_question") {
      if (dimension === "version") right.identity.questionRef.contentVersion++;
      if (dimension === "revision") right.identity.questionRef.revisionNumber++;
    }
    expect(compareCourseQuestionIdentity(left, right)).toBe("conflict");
  });
  it("distinguishes genuinely different questions without treating a shared source as a same-question binding", () => {
    const left = question(), right = question();
    if (right.identity.questionRef.kind === "teaching_question") right.identity.questionRef.questionBlockId = id(9);
    right.conditions = "Calculate 2+2";
    right.answer = "4";
    expect(compareCourseQuestionIdentity(left, right)).toBe("different");
    right.conditions = left.conditions; right.answer = left.answer;
    right.interaction = { kind: "numeric", unit: "m" };
    expect(compareCourseQuestionIdentity(left, right)).toBe("different");
  });
  it("keeps same-binding contradictory keys/roles conflicting even with semantic hints", () => {
    const left = question(), right = question(); right.answer = "3";
    expect(compareCourseQuestionIdentity(left, right, "semantic")).toBe("conflict");
    right.answer = left.answer;
    if (right.identity.questionRef.kind === "teaching_question") right.identity.questionRef.answerBlockId = id(9);
    expect(compareCourseQuestionIdentity(left, right)).toBe("conflict");
  });
  it("keeps missing evidence unknown and semantic/model matches candidates", () => {
    expect(compareCourseQuestionIdentity(question(), null, "semantic")).toBe("unknown");
    for (const basis of ["semantic", "model"] as const) {
      const other = question(); other.conditions = "What is two?";
      if (other.identity.questionRef.kind === "teaching_question") other.identity.questionRef.questionBlockId = id(9);
      expect(compareCourseQuestionIdentity(question(), other, basis)).toBe("candidate");
    }
  });
});
