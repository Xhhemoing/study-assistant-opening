import type { TeachingQuestionInteraction } from "@aistudy/contracts";
import { checkArithmeticAnswer, equalArithmeticValues, evaluateArithmeticQuestion, parseArithmeticLiteral } from "./arithmetic-check";

/** The client renders the stem and option labels as Markdown; only content whose meaning survives rendering can be graded. */
function keepsMeaningWhenRendered(question: string, interaction: TeachingQuestionInteraction | undefined): boolean {
  // A $ pair is trusted as math only within one line; a blank line splits it into separate paragraphs.
  if (question.replace(/\$[^$\r\n]*\$/g, "").includes("*")) return false;
  // Per line rather than /m: a multiline ^\s* rescans runs of blank lines quadratically.
  if (question.split(/\r\n?|\n/).some(line => /^\s*(?:-+|[+*]|\d{1,9}[.)])(?:\s|$)/.test(line))) return false;
  return interaction?.kind !== "choice" || interaction.options.every(option => parseArithmeticLiteral(option.label) !== null);
}

/** Independent evaluation of the pinned question and key; null means no authority. */
export function evaluateTeachingAnswer(question: string, interaction: TeachingQuestionInteraction | undefined,
  key: string | null, answer: string): "correct" | "incorrect" | "unparseable" | null {
  if (!keepsMeaningWhenRendered(question, interaction)) return null;
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
  const prefixIds = new Set(interaction.options.filter(option => {
    for (const lead of ["", "(", "（"]) {
      const start = lead + option.id;
      if (!trimmed.startsWith(start)) continue;
      let tail = trimmed.slice(start.length);
      if (tail.startsWith(")") || tail.startsWith("）")) tail = tail.slice(1);
      if (!tail || /^[\s.．、:：,，]/u.test(tail)) return true;
    }
    return false;
  }).map(option => option.id));
  if (prefixIds.size > 1) return null;
  if (prefixIds.size === 1 ? !prefixIds.has(matches[0]!.id) : checkArithmeticAnswer(question, key) !== "correct") return null;
  const submitted = interaction.options.filter(option => answer === `${option.id}. ${option.label}`);
  if (submitted.length === 0) return "unparseable";
  if (submitted.length > 1) return null;
  return submitted[0]!.id === matches[0]!.id ? "correct" : "incorrect";
}
