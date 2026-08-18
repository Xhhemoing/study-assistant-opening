import { describe, expect, it } from "vitest";
import type { PracticeItem } from "@aistudy/contracts";
import { gradePracticeAnswer, isPracticeAnswerCorrect, normalizeAnswer } from "./grading";

function item(partial: Partial<PracticeItem> & { answer: string }): PracticeItem {
  return {
    id: "22222222-2222-4222-8222-222222222201",
    syllabusPointId: "11111111-1111-4111-8111-111111111101",
    kind: "short_answer",
    stem: "题干",
    answer: partial.answer,
    hints: ["提示"],
    abilitySlice: "recall",
    estimatedMinutes: 5,
    contentVersion: 1,
    ...partial,
  };
}

describe("normalizeAnswer", () => {
  it("normalizes full-width, whitespace, and case", () => {
    expect(normalizeAnswer("　ＦＯＯ　ＢＡＲ\n")).toBe("foo bar");
  });
});

describe("isPracticeAnswerCorrect", () => {
  it("matches multiple choice exactly", () => {
    expect(isPracticeAnswerCorrect(item({ kind: "multiple_choice", answer: "a" }), "a")).toBe(true);
  });

  it("accepts CJK substring in short answers", () => {
    expect(isPracticeAnswerCorrect(item({ kind: "short_answer", answer: "极限" }), "函数的极限定义")).toBe(true);
  });

  it("does not match an ASCII substring inside a larger token", () => {
    expect(isPracticeAnswerCorrect(item({ kind: "short_answer", answer: "2" }), "12")).toBe(false);
  });

  it("matches a standalone numeric token in an expression", () => {
    expect(isPracticeAnswerCorrect(item({ kind: "short_answer", answer: "2" }), "x=2")).toBe(true);
  });

  it("matches checkpoint values ignoring order and full-width", () => {
    expect(isPracticeAnswerCorrect(item({ kind: "checkpoint", answer: "0,2" }), " ２，０ ")).toBe(true);
  });
});

describe("gradePracticeAnswer", () => {
  it("grades an exact rule against normalized accepted answers", () => {
    expect(gradePracticeAnswer({ type: "exact", accepted: ["极限", "导数"] }, "　极限　")).toBe(true);
    expect(gradePracticeAnswer({ type: "exact", accepted: ["极限"] }, "函数的极限定义")).toBe(false);
  });

  it("grades a token_set rule without substring matching", () => {
    expect(gradePracticeAnswer({ type: "token_set", accepted: [["0", "2"]] }, " ２，０ ")).toBe(true);
    expect(gradePracticeAnswer({ type: "token_set", accepted: [["极限"]] }, "函数的极限定义")).toBe(false);
    expect(gradePracticeAnswer({ type: "token_set", accepted: [["2"]] }, "12")).toBe(false);
  });
});
