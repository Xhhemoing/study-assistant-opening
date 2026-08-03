import { describe, expect, it } from "vitest";
import type { PracticeItem } from "@aistudy/contracts";
import { isPracticeAnswerCorrect, normalizeAnswer } from "../../lib/data/practice-answers";
import {
  createPracticePlayerState,
  getSubmissionIssue,
  type PracticePlayerState,
} from "./practice-player-model";

const item = (overrides: Partial<PracticeItem>): PracticeItem => ({
  id: "22222222-2222-4222-8222-222222222201",
  syllabusPointId: "11111111-1111-4111-8111-111111111101",
  kind: "multiple_choice",
  stem: "题目",
  options: ["A. 正确", "B. 错误"],
  answer: "A",
  hints: ["提示"],
  abilitySlice: "recall",
  estimatedMinutes: 5,
  contentVersion: 1,
  ...overrides,
});

describe("practice player model", () => {
  it("normalizes surrounding whitespace, case, and full-width characters", () => {
    expect(normalizeAnswer("　ＦＯＯ　ＢＡＲ\n")).toBe("foo bar");
  });

  it("compares checkpoint answers as normalized sets", () => {
    expect(isPracticeAnswerCorrect(item({ kind: "checkpoint", answer: "0,2" }), " ２，０ ")).toBe(true);
  });

  it("accepts a short answer containing the normalized expected phrase", () => {
    expect(isPracticeAnswerCorrect(item({ kind: "short_answer", answer: "极限" }), "函数的极限定义")).toBe(true);
  });

  it("requires a verdict, confidence, and an error cause for wrong answers", () => {
    const base = createPracticePlayerState();
    expect(getSubmissionIssue(base)).toBe("answer-required");
    expect(getSubmissionIssue({ ...base, answer: "B" })).toBe("verdict-required");

    const wrongVerdict: PracticePlayerState = {
      ...base,
      phase: "verdict",
      answer: "B",
      verdict: false,
    };
    expect(getSubmissionIssue(wrongVerdict)).toBe("confidence-required");
    expect(getSubmissionIssue({ ...wrongVerdict, confidence: 2 })).toBe("error-cause-required");
    expect(getSubmissionIssue({ ...wrongVerdict, confidence: 2, errorCause: "concept" })).toBeNull();
  });

  it("blocks duplicate submission while the attempt is in flight or complete", () => {
    const state: PracticePlayerState = {
      ...createPracticePlayerState(),
      phase: "submitting",
      answer: "A",
      verdict: true,
      confidence: 4,
    };
    expect(getSubmissionIssue(state)).toBe("submitting");
    expect(getSubmissionIssue({ ...state, phase: "submitted" })).toBe("submitted");
  });
});
