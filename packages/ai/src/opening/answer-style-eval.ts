import type { TutorMode } from "@aistudy/contracts";
import type { AnswerStyleCategory } from "./answer-style-samples";

/** Per-category character budgets (whitespace stripped). */
export const ANSWER_STYLE_BUDGETS: Readonly<Record<AnswerStyleCategory, number>> = {
  fact: 150,
  concept: 600,
  comparison: 600,
  process: 600,
  derivation: 1200,
  code: 1200,
};

export type AnswerStyleScoreInput = {
  category: AnswerStyleCategory;
  mode: TutorMode;
};

export type AnswerStyleScore = {
  firstParagraphSentences: number;
  directFirstParagraph: boolean;
  charCount: number;
  withinBudget: boolean;
  rawHtml: boolean;
  unbalancedMath: boolean;
  headingCount: number;
  hintViolation: boolean;
  pass: boolean;
};

export type AnswerStyleSummary = {
  total: number;
  passed: number;
  directRate: number;
  withinBudgetRate: number;
  rawHtmlCount: number;
  unbalancedMathCount: number;
  hintViolationCount: number;
};

const SENTENCE_END = /[。！？.!?]/;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/;
const HINT_ANSWER_MARKERS = ["最终答案", "答案是", "综上"] as const;

/** Remove fenced code blocks (``` ... ```), including the fences. */
function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

function firstParagraph(text: string): string {
  const parts = text.split(/\n\s*\n/);
  return (parts[0] ?? "").trimEnd();
}

/**
 * Count sentences in a paragraph.
 * Terminators: 。！？.!? and newlines.
 */
function countSentences(paragraph: string): number {
  const trimmed = paragraph.trim();
  if (!trimmed) return 0;

  let count = 0;
  let buf = "";
  for (const ch of trimmed) {
    if (ch === "\n" || SENTENCE_END.test(ch)) {
      if (buf.trim().length > 0) count += 1;
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) count += 1;
  return count;
}

function countHeadings(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (/^#{1,6}\s/.test(line) || /^#{1,6}$/.test(line)) count += 1;
  }
  return count;
}

/**
 * Count math delimiters after stripping fences.
 * Unescaped `$` each count 1; `$$` counts as one unit.
 * Odd total => unbalanced.
 */
function hasUnbalancedMath(textWithoutFences: string): boolean {
  let count = 0;
  let i = 0;
  const s = textWithoutFences;
  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length && s[i + 1] === "$") {
      i += 2;
      continue;
    }
    if (s[i] === "$") {
      if (i + 1 < s.length && s[i + 1] === "$") {
        count += 1;
        i += 2;
        continue;
      }
      count += 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return count % 2 === 1;
}

function hasHintViolation(mode: TutorMode, text: string, headingCount: number): boolean {
  if (mode !== "hint") return false;
  if (headingCount > 0) return true;
  return HINT_ANSWER_MARKERS.some((m) => text.includes(m));
}

export function scoreAnswerStyle(text: string, sample: AnswerStyleScoreInput): AnswerStyleScore {
  const paragraph = firstParagraph(text);
  const firstParagraphSentences = countSentences(paragraph);
  const directFirstParagraph = firstParagraphSentences <= 2;

  const charCount = text.replace(/\s/g, "").length;
  const budget = ANSWER_STYLE_BUDGETS[sample.category];
  const withinBudget = charCount <= budget;

  const withoutFences = stripCodeFences(text);
  const rawHtml = HTML_TAG.test(withoutFences);
  const unbalancedMath = hasUnbalancedMath(withoutFences);
  const headingCount = countHeadings(text);
  const hintViolation = hasHintViolation(sample.mode, text, headingCount);

  const pass =
    directFirstParagraph && withinBudget && !rawHtml && !unbalancedMath && !hintViolation;

  return {
    firstParagraphSentences,
    directFirstParagraph,
    charCount,
    withinBudget,
    rawHtml,
    unbalancedMath,
    headingCount,
    hintViolation,
    pass,
  };
}

export function summarizeAnswerStyle(results: readonly AnswerStyleScore[]): AnswerStyleSummary {
  const total = results.length;
  if (total === 0) {
    return {
      total: 0,
      passed: 0,
      directRate: 0,
      withinBudgetRate: 0,
      rawHtmlCount: 0,
      unbalancedMathCount: 0,
      hintViolationCount: 0,
    };
  }

  let passed = 0;
  let direct = 0;
  let within = 0;
  let rawHtmlCount = 0;
  let unbalancedMathCount = 0;
  let hintViolationCount = 0;

  for (const r of results) {
    if (r.pass) passed += 1;
    if (r.directFirstParagraph) direct += 1;
    if (r.withinBudget) within += 1;
    if (r.rawHtml) rawHtmlCount += 1;
    if (r.unbalancedMath) unbalancedMathCount += 1;
    if (r.hintViolation) hintViolationCount += 1;
  }

  return {
    total,
    passed,
    directRate: direct / total,
    withinBudgetRate: within / total,
    rawHtmlCount,
    unbalancedMathCount,
    hintViolationCount,
  };
}
