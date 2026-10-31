import type { StudySessionView } from "../model";

/** Read-only projection. PracticeForm retains drafts, requests, grading and actions. */
export function photoPracticeView(input: { attemptId: string; stem: string; answer: string; saved: boolean; locked: boolean }): StudySessionView {
  return {
    step: { kind: "practice", id: input.attemptId, title: input.saved ? "已保存的作答" : "完成自己的尝试", prompt: input.stem, estimateMinutes: null },
    answer: { answer: input.answer }, locked: input.locked,
    // The original result card owns verdict wording and the next real action.
    result: null, next: null,
    help: { level: "none", hintsShown: 0, tutorAsked: false, texts: [], canRequest: false },
  };
}
