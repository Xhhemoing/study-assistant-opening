import type { SpanTeachingMode, StudySessionIntent } from "@aistudy/contracts";
import { createSpanTeachingSequence } from "@aistudy/domain";

/** Lesson steps: the teaching sequence plus the server-issued reserved item. Shared by the legacy lesson and the v2 session. */
export function spanLessonMoves(mode: SpanTeachingMode) {
  const sequence = createSpanTeachingSequence(mode);
  return [...sequence, { ...sequence[sequence.length - 1]!, id: `${mode}-reserved`, presentation: { kind: "independent_item" as const, instructions: "离开示范，用服务器发放的保留题检查" } }];
}

/** Practice problem for a lesson step; the last step is the reserved item. */
export function spanLessonProblemId(mode: SpanTeachingMode, step: number, total: number): string {
  return step === total - 1 ? "reserved:auto" : mode === "self_study" ? step === 1 ? "span-faded-3d" : "span-independent-3d"
    : mode === "overview" ? step === 1 ? "span-contrast-dependent" : "span-geometry-transfer"
      : "span-geometry-transfer";
}

/** Teaching move recorded for a practice problem. The session service accepts only teaching-sequence moves, never `*-reserved`. */
export function spanPracticeMoveId(purpose: StudySessionIntent["purpose"], spanProblemId: string): string {
  return purpose === "overview" ? spanProblemId === "span-contrast-dependent" ? "overview-contrast" : "overview-mixed"
    : purpose === "challenge" ? "challenge-transfer" : spanProblemId === "span-faded-3d" ? "self-faded" : "self-independent";
}
