import type { ErrorCause } from "@aistudy/contracts";

export type PracticePlayerPhase = "answering" | "verdict" | "submitting" | "submitted";

export interface PracticePlayerState {
  phase: PracticePlayerPhase;
  answer: string;
  hintCount: number;
  assisted: boolean;
  confidence: number | null;
  errorCause: ErrorCause | null;
  verdict: boolean | null;
}

export type SubmissionIssue =
  | "answer-required"
  | "verdict-required"
  | "confidence-required"
  | "error-cause-required"
  | "submitting"
  | "submitted";

export function createPracticePlayerState(): PracticePlayerState {
  return {
    phase: "answering",
    answer: "",
    hintCount: 0,
    assisted: false,
    confidence: null,
    errorCause: null,
    verdict: null,
  };
}

export function getSubmissionIssue(state: PracticePlayerState): SubmissionIssue | null {
  if (state.phase === "submitting") return "submitting";
  if (state.phase === "submitted") return "submitted";
  if (!state.answer.trim()) return "answer-required";
  if (state.phase !== "verdict" || state.verdict === null) return "verdict-required";
  if (state.confidence === null || state.confidence < 1 || state.confidence > 5) return "confidence-required";
  if (!state.verdict && !state.errorCause) return "error-cause-required";
  return null;
}
