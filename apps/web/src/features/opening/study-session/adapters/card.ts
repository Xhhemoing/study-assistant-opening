import type { ReviewGrade, ReviewQueueItem } from "@aistudy/contracts";
import type { StudySessionView } from "../model";

export const cardRecallOptions: { value: ReviewGrade; label: string }[] = [
  { value: "again", label: "重来" },
  { value: "hard", label: "困难" },
  { value: "good", label: "记得" },
  { value: "easy", label: "轻松" },
];
export function cardRecallGrade(value: string): ReviewGrade | null {
  return cardRecallOptions.find(option => option.value === value)?.value ?? null;
}
export function cardRecallLabel(grade: ReviewGrade): string {
  return cardRecallOptions.find(option => option.value === grade)!.label;
}
/** Presentation adapter only: the existing card owner retains queue, save and receipt handling. */
export function cardStudyView(item: ReviewQueueItem, flipped: boolean, grade: ReviewGrade | null, selectionLocked: boolean, savedRecall: string | null): StudySessionView {
  return {
    step: { kind: "card", id: item.card.id, title: "回忆这个知识点", front: item.card.front, back: flipped ? item.card.back : "", flipped, gradeOptions: cardRecallOptions, selectionLocked, savedRecall, estimateMinutes: null },
    answer: grade ? { grade } : {}, locked: false, result: null, next: null,
    help: { level: "none", hintsShown: 0, tutorAsked: false, texts: [], canRequest: false },
  };
}
