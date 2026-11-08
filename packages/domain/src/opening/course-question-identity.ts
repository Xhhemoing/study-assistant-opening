import type { QuestionIdentity, QuestionIdentityMatch } from "@aistudy/contracts";

/** Private server-resolved values, not a client identity claim or a model receipt. */
export type ResolvedCourseQuestion = {
  identity: QuestionIdentity;
  conditions: string;
  interaction: unknown;
  answer: string;
};
// `different` is private: the public receipt union deliberately grants no unseen authority.
export type CourseQuestionComparison = QuestionIdentityMatch["result"]["kind"] | "different";

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, i) => equal(value, right[i]));
  if (left && right && typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
  }
  return false;
}

function sameRefs(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every(ref => right.some(other => equal(ref, other)))
    && right.every(ref => left.some(other => equal(ref, other)));
}

/** Stable question binding, excluding versions and answer IDs so contradictions remain detectable. */
function sameCourseQuestionBinding(a: QuestionIdentity["questionRef"], b: QuestionIdentity["questionRef"]): boolean {
  if (a.kind === "teaching_question" && b.kind === "teaching_question") return a.activityId === b.activityId
    && a.documentId === b.documentId && a.questionBlockId === b.questionBlockId;
  if (a.kind === "source_problem" && b.kind === "source_problem") return a.sourceId === b.sourceId && a.problemId === b.problemId;
  return a.kind === "exam_question" && b.kind === "exam_question" && a.packId === b.packId && a.questionId === b.questionId;
}

/** Exact is byte-preserving: no whitespace/units/figure normalization, hashes or semantic verdicts.
 * Different block/registry UUIDs can name the same resolved content. Immutable versions
 * and figure refs must still agree. Unknown/candidate never authorize dedup or unseen.
 */
export function compareCourseQuestionIdentity(left: ResolvedCourseQuestion | null, right: ResolvedCourseQuestion | null,
  similarity?: "semantic" | "model"): CourseQuestionComparison {
  if (!left || !right || !left.conditions || !right.conditions || !left.answer || !right.answer) return "unknown";
  const a = left.identity, b = right.identity;
  const bound = sameCourseQuestionBinding(a.questionRef, b.questionRef);
  const mismatch = () => bound ? "conflict" as const : "different" as const;
  if (a.questionRef.kind !== b.questionRef.kind) return "unknown";
  if (!sameRefs(a.sourceRefs, b.sourceRefs) || a.answerRole !== b.answerRole) return mismatch();
  if (a.questionRef.kind === "teaching_question" && b.questionRef.kind === "teaching_question"
    && (a.questionRef.contentVersion !== b.questionRef.contentVersion || a.questionRef.revisionNumber !== b.questionRef.revisionNumber)) return mismatch();
  if (a.questionRef.kind === "source_problem" && b.questionRef.kind === "source_problem"
    && a.questionRef.sourceVersion !== b.questionRef.sourceVersion) return mismatch();
  if (a.questionRef.kind === "exam_question" && b.questionRef.kind === "exam_question"
    && (a.questionRef.packId !== b.questionRef.packId || a.questionRef.packVersion !== b.questionRef.packVersion
      || a.questionRef.familyId !== b.questionRef.familyId)) return mismatch();
  if (!sameRefs(a.figureRefs, b.figureRefs)) return mismatch();
  if (left.conditions !== right.conditions || !equal(left.interaction, right.interaction)) {
    return bound ? "conflict" : similarity ? "candidate" : "different";
  }
  // Identical stems with inconsistent keys cannot establish a new question.
  if (left.answer !== right.answer) return bound ? "conflict" : "unknown";
  if (bound && !equal(a.questionRef, b.questionRef)) return "conflict";
  return equal(a.questionRef, b.questionRef) ? "same" : "equivalent_exact";
}
