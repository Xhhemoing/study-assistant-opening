import type { StudySessionView } from "../model";

/** Display projection only: PracticeForm owns answer, submission and grading. */
export function photoPracticeView(input: { attemptId: string; stem: string; canSubmit: boolean; sealed: boolean; recorded: boolean }): StudySessionView {
  return {
    step: { kind: "photo_practice", id: input.attemptId, title: "拍题练习", prompt: input.stem,
      estimateMinutes: null, canSubmit: input.canSubmit, recorded: input.recorded },
    position: { index: 0, total: 1 }, help: { level: "none", hints: [], next: null },
    answer: {}, sealed: input.sealed, result: null, next: null, photo: null,
  };
}