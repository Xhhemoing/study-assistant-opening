import type { PracticeItem } from "@aistudy/contracts";

export function normalizeAnswer(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function checkpointValues(value: string): Set<string> {
  return new Set(normalizeAnswer(value).split(",").map((part) => part.trim()).filter(Boolean));
}

function isSubAnswer(actual: string, expected: string): boolean {
  // CJK answers keep substring semantics ("极限" ⊂ "函数的极限定义").
  if (/[\u4e00-\u9fff]/.test(expected)) return actual.includes(expected);
  // ASCII/numeric answers require a token-boundary match so "12" does not match "2".
  const tokens = new Set(actual.split(/[^0-9a-z]+/).filter(Boolean));
  return tokens.has(expected);
}

export function isPracticeAnswerCorrect(item: PracticeItem, answer: string): boolean {
  if (item.kind === "checkpoint") {
    const actual = checkpointValues(answer);
    const expected = checkpointValues(item.answer);
    return actual.size === expected.size && [...actual].every((value) => expected.has(value));
  }

  const actual = normalizeAnswer(answer);
  const expected = normalizeAnswer(item.answer);
  return actual === expected || (item.kind === "short_answer" && isSubAnswer(actual, expected));
}
