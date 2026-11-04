import { isDeepStrictEqual } from "node:util";
import type { TeachingBlockRef } from "@aistudy/contracts";
import { checkArithmeticAnswer } from "@aistudy/domain";
import { teachingQuestionText } from "./opening-teaching-question";
import { learningError } from "./opening-learning-facts";

type Block = { id: string; type: string; content: Record<string, unknown> };
const textFields = new Set(["text", "markdown", "answer", "solution"]);

/** Validate the entire immutable revision, including blocks not selected by the spec. */
export function assertReferenceTextRevision(order: TeachingBlockRef[], before: Block[], after: Block[]) {
  const ordered = [...order].sort((a, b) => a.position - b.position);
  const answers = new Map<string, Block>();
  for (const [index, ref] of ordered.entries()) {
    const prompt = before.find(b => b.id === ref.blockId);
    const next = ordered[index + 1];
    if (ref.role !== "answer_key" && (ref.role === "prompt" || ["prompt", "question"].includes(ref.blockType))
      && prompt && ["prompt", "question"].includes(prompt.type) && teachingQuestionText(prompt.content)
      && next && (next.role === "answer_key" || ["answer_key", "solution"].includes(next.blockType))) answers.set(next.blockId, prompt);
  }
  if (before.length !== after.length) throw learningError("VALIDATION", "only reference answer text may change");
  let changed = false;
  for (const [index, old] of before.entries()) {
    const next = after[index]!;
    if (isDeepStrictEqual(old, next)) continue;
    const prompt = answers.get(old.id);
    if (!prompt || !["answer_key", "solution"].includes(old.type)) throw learningError("VALIDATION", "only bound reference answer text may change");
    const oldRest = { ...old, content: { ...old.content } }, newRest = { ...next, content: { ...next.content } };
    for (const key of textFields) {
      if (!isDeepStrictEqual(old.content[key], next.content[key])) {
        if (typeof next.content[key] !== "string" || !(next.content[key] as string).trim()) throw learningError("VALIDATION", "reference answer text must not be empty");
        changed = true;
      }
      delete oldRest.content[key]; delete newRest.content[key];
    }
    if (!isDeepStrictEqual(oldRest, newRest)) throw learningError("VALIDATION", "only reference answer text may change");
    const answerTexts = [...textFields].map(key => next.content[key])
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    const question = teachingQuestionText(prompt.content)!;
    // Alternate saved representations remain part of this revision even when
    // a higher-priority text field is correct. Unknown prose stays reviewable.
    if (!answerTexts.length || answerTexts.some(answer => checkArithmeticAnswer(question, answer) === "incorrect")) {
      throw learningError("VALIDATION", "reference answer does not match the question");
    }
  }
  if (!changed) throw learningError("VALIDATION", "reference answer text has not changed");
}
