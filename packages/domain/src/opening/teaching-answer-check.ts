import type { TeachingQuestionInteraction } from "@aistudy/contracts";
import { checkArithmeticAnswer, equalArithmeticValues, evaluateArithmeticQuestion, parseArithmeticLiteral } from "./arithmetic-check";
import { evaluateSymbolicTeachingAnswer, matchSavedChoiceSubmission, savedChoiceKeyIds, savedChoiceKeySuffix } from "./symbolic-answer-bridge";

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
  const expected = evaluateArithmeticQuestion(question);
  if (expected === null) return evaluateSymbolicTeachingAnswer(question, interaction, key, answer);
  if (!keepsMeaningWhenRendered(question, interaction) || !interaction || !key?.trim()) return null;
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
  const [match] = matches;
  if (!match || matches.length !== 1) return null;
  const prefixIds = savedChoiceKeyIds(interaction.options, key);
  if (prefixIds.size > 1) return null;
  if (prefixIds.size === 1) {
    const suffix = savedChoiceKeySuffix(key, match.id);
    if (suffix === null || (suffix && checkArithmeticAnswer(question, suffix) !== "correct")) return null;
  } else if (checkArithmeticAnswer(question, key) !== "correct") return null;
  return matchSavedChoiceSubmission(interaction.options, answer, match.id);
}
