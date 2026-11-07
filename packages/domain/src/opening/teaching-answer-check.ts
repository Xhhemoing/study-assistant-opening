import type { TeachingQuestionInteraction } from "@aistudy/contracts";
import { checkArithmeticAnswer, equalArithmeticValues, evaluateArithmeticQuestion, parseArithmeticLiteral } from "./arithmetic-check";

/** Independent evaluation of the pinned question and key; null means no authority. */
export function evaluateTeachingAnswer(question: string, interaction: TeachingQuestionInteraction | undefined,
  key: string | null, answer: string): "correct" | "incorrect" | "unparseable" | null {
  const expected = evaluateArithmeticQuestion(question);
  if (!expected || !interaction || !key?.trim()) return null;
  if (interaction.kind === "numeric") {
    if (interaction.unit !== undefined || checkArithmeticAnswer(question, key) !== "correct") return null;
    const value = parseArithmeticLiteral(answer);
    if (!value) return "unparseable";
    if (answer.includes(".")) {
      let denominator = expected.d;
      while (denominator % 2n === 0n) denominator /= 2n;
      while (denominator % 5n === 0n) denominator /= 5n;
      if (denominator !== 1n) return "unparseable";
    }
    return equalArithmeticValues(expected, value) ? "correct" : "incorrect";
  }
  const matches = interaction.options.filter(option => {
    const value = parseArithmeticLiteral(option.label);
    return value && equalArithmeticValues(expected, value);
  });
  if (matches.length !== 1) return null;
  const trimmed = key.trim();
  const prefix = interaction.options.find(option => {
    for (const lead of ["", "(", "（"]) {
      const start = lead + option.id;
      if (!trimmed.startsWith(start)) continue;
      let tail = trimmed.slice(start.length);
      if (tail.startsWith(")") || tail.startsWith("）")) tail = tail.slice(1);
      if (!tail || /^[\s.．、:：,，]/u.test(tail)) return true;
    }
    return false;
  });
  if (prefix ? prefix.id !== matches[0]!.id : checkArithmeticAnswer(question, key) !== "correct") return null;
  const split = answer.indexOf(". ");
  const id = split < 0 ? "" : answer.slice(0, split);
  if (!interaction.options.some(option => option.id === id)) return "unparseable";
  return id === matches[0]!.id ? "correct" : "incorrect";
}
