import type { ReviewGrade, ReviewQueueItem } from "@aistudy/contracts";
import type { StudySessionView } from "../model";

/** Projection only: the existing review owner retains queue, selection and grade requests. */
export function cardStudySessionView(item: ReviewQueueItem, position: StudySessionView["position"], flipped: boolean, grade: ReviewGrade | null): StudySessionView {
  return {
    step: { kind: "card", id: item.card.id, title: "记忆卡片", front: item.card.front,
      ...(flipped ? { back: item.card.back } : {}), flipped, grade, estimateMinutes: null },
    position, help: { level: "none", hints: [], next: null }, answer: {}, sealed: false,
    result: null, next: null, photo: null,
  };
}
