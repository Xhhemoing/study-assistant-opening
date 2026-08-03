import type { PracticeItem } from "@aistudy/contracts";

export function normalizeAnswer(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function checkpointValues(value: string): Set<string> {
  return new Set(normalizeAnswer(value).split(",").map((part) => part.trim()).filter(Boolean));
}

export function isPracticeAnswerCorrect(item: PracticeItem, answer: string): boolean {
  if (item.kind === "checkpoint") {
    const actual = checkpointValues(answer);
    const expected = checkpointValues(item.answer);
    return actual.size === expected.size && [...actual].every((value) => expected.has(value));
  }

  const actual = normalizeAnswer(answer);
  const expected = normalizeAnswer(item.answer);
  return actual === expected || (item.kind === "short_answer" && actual.includes(expected));
}
