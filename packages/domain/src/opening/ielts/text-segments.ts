import { graphemeBoundaries } from "./graphemes";

export type GroundedTextSpan = {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
};

export type GroundedClause = GroundedTextSpan & {
  readonly parts: readonly GroundedTextSpan[];
  readonly spokenParts: readonly GroundedTextSpan[];
};

export type GroundedSentence = GroundedTextSpan & {
  readonly clauses: readonly GroundedClause[];
};

const PREFIX_ABBREVIATIONS = new Set(["dr", "mr", "mrs", "ms", "prof", "st", "vs"]);
const SENTENCE_START = /^(?:I|He|She|It|They|We|This|That|The|However|Then|Next)\b/u;
const WORD_CHARACTER = /[\p{L}\p{M}\p{N}]/u;
const CLOSING_QUOTES = new Map([['"', '"'], ["“", "”"], ["'", "'"], ["‘", "’"]]);

function isAbbreviationPeriod(text: string, index: number): boolean {
  const preceding = text.slice(Math.max(0, index - 8), index);
  const following = text.slice(index + 1);
  if (/\d$/u.test(preceding) && /^\d/u.test(following)) return true;
  if (/[\p{L}]$/u.test(preceding) && /^[\p{L}]\./u.test(following)) return true;

  const word = preceding.match(/[\p{L}]+$/u)?.[0] ?? "";
  const nextWord = following.trimStart();
  if (!/^[\p{L}\p{N}]/u.test(nextWord)) return false;
  if (word.toLowerCase() === "no") return /^\d/u.test(nextWord);
  if (PREFIX_ABBREVIATIONS.has(word.toLowerCase())) return true;
  if (/(?<![\p{L}])(?:e\.g|i\.e)$/iu.test(preceding)) return true;
  if (word.toLowerCase() === "etc") return !/^\p{Lu}/u.test(nextWord);
  if (/(?<![\p{L}])(?:U\.S|U\.K)$/iu.test(preceding)) {
    return !SENTENCE_START.test(nextWord);
  }
  return /^[A-Z]$/u.test(word) && /^[A-Z]/u.test(nextWord);
}

/** Splits once on the original UTF-16 text. All spans can be sliced directly from that text. */
export function segmentIeltsText(text: string): GroundedSentence[] {
  const boundaries = graphemeBoundaries(text);
  const sentences: GroundedSentence[] = [];
  let clauses: GroundedClause[] = [];
  let parts: GroundedTextSpan[] = [];
  let spokenParts: GroundedTextSpan[] = [];
  let sentenceStart = 0;
  let clauseStart = 0;
  let partStart = 0;
  let spokenPartStart = 0;
  const quotes: string[] = [];
  let quotedSentenceEnd = -1;

  function span(start: number, end: number): GroundedTextSpan | undefined {
    const raw = text.slice(start, end);
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const startOffset = boundaries.floor(start + raw.length - raw.trimStart().length);
    const endOffset = boundaries.ceil(start + raw.trimEnd().length);
    return { text: text.slice(startOffset, endOffset), startOffset, endOffset };
  }

  function closeSpokenPart(end: number, next: number) {
    const current = span(spokenPartStart, end);
    if (current) spokenParts.push(current);
    spokenPartStart = next;
  }

  function closePart(end: number, next: number) {
    const current = span(partStart, end);
    if (current) parts.push(current);
    partStart = next;
    closeSpokenPart(end, next);
  }

  function closeClause(end: number, next: number) {
    closePart(end, next);
    const current = span(clauseStart, end);
    if (current) clauses.push({ ...current, parts, spokenParts });
    parts = [];
    spokenParts = [];
    clauseStart = next;
  }

  function closeSentence(end: number, clauseEnd: number, next: number) {
    closeClause(clauseEnd, next);
    const current = span(sentenceStart, end);
    if (current) sentences.push({ ...current, clauses });
    clauses = [];
    sentenceStart = next;
  }

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    const previous = text[i - 1] ?? "";
    const following = text[i + 1] ?? "";
    const apostropheInWord = (char === "'" || char === "’") &&
      WORD_CHARACTER.test(previous) && WORD_CHARACTER.test(following);

    if (char === quotes.at(-1) && !apostropheInWord) {
      quotes.pop();
      if (quotes.length === 0) {
        const quoteEnd = boundaries.ceil(i + 1);
        if (
          quotedSentenceEnd >= 0 && !text.slice(quotedSentenceEnd, i).trim() &&
          /^\s+[\p{Lu}\p{N}“"'‘]/u.test(text.slice(quoteEnd))
        ) {
          closeSentence(quoteEnd, quoteEnd, quoteEnd);
        }
        quotedSentenceEnd = -1;
      }
      continue;
    }

    const closingQuote = CLOSING_QUOTES.get(char);
    if (closingQuote && !apostropheInWord && (char !== "'" || !WORD_CHARACTER.test(previous))) {
      quotes.push(closingQuote);
      continue;
    }
    if (/[.!?]/u.test(char) && !(char === "." && isAbbreviationPeriod(text, i))) {
      let end = i + 1;
      while (/[.!?]/u.test(text[end] ?? "")) end += 1;
      end = boundaries.ceil(end);
      if (quotes.length > 0) {
        quotedSentenceEnd = end;
        // Keep the full quotation in the sentence while isolating its clauses.
        if (!text.slice(end).trimStart().startsWith(quotes.at(-1)!)) closeClause(i, end);
      } else {
        closeSentence(end, i, end);
      }
      i = end - 1;
    } else if (quotes.length === 0) {
      if (char === "\n" || char === "\r") {
        const next = boundaries.ceil(i + 1);
        closeSentence(i, i, next);
        i = next - 1;
      } else if (
        /[;:—–()[\]]/u.test(char) ||
        (char === "-" && (following === "-" || (/\s/u.test(previous) && /\s/u.test(following))))
      ) {
        let end = boundaries.ceil(i + 1);
        if (char === "-") {
          while (text[end] === "-") end += 1;
        }
        closeClause(i, end);
        i = end - 1;
      } else if (/[,，、]/u.test(char) || char === "/") {
        const next = boundaries.ceil(i + 1);
        if (char === "/") closeSpokenPart(i, next);
        else closePart(i, next);
        i = next - 1;
      }
    }
  }

  closeSentence(text.length, text.length, text.length);
  return sentences;
}
