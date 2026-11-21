import { graphemeBoundaries, trimToProseGraphemes } from "./graphemes";
import { countProseWords, maskIeltsParagraphs } from "./prose";
import { allocateIeltsSpans, compareText, rangesOverlap, type MatchRange } from "./span-allocation";
import { segmentIeltsText, type GroundedClause, type GroundedSentence, type GroundedTextSpan } from "./text-segments";
import { getUniqueWritingTargets, getWritingDraftSource, getWritingTransferSource } from "./writing-source";
import {
  clampToIeltsBand,
  createValidatedRubricReceipt,
  detectMemorizedTemplates,
  getWritingTransferLineage,
  hasMemorizedTemplateStuffing,
  resolveIeltsEpistemicStatus,
} from "./rubric";
import type {
  IeltsBandScore,
  IeltsCriterion,
  IeltsCriterionAssessment,
  IeltsCrossDraftTransferReport,
  IeltsEssayDraft,
  IeltsParagraphDiff,
  IeltsRubricReceipt,
  IeltsSpanEvidence,
  IeltsTransferStatus,
  IeltsUpgradeTarget,
  IeltsUpgradeTransferItem,
} from "./types";

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "has", "had",
  "are", "was", "were", "will", "would", "could", "should", "into", "onto",
  "about", "more", "most", "some", "many", "such", "very", "also", "than",
  "then", "they", "them", "their", "there", "these", "those", "only", "just",
  "can", "not", "but", "all", "one", "two", "its", "our", "you", "your",
]);

const TOPIC_SCAFFOLD_STOP_WORDS = new Set([
  ...STOP_WORDS,
  "when", "where", "which", "who", "whom", "whose", "what", "why", "how",
  "everyone", "everybody", "anyone", "anybody", "someone", "somebody",
  "nobody", "nothing", "everything", "something",
  "per", "via", "upon", "either", "neither", "nor", "yet", "thus", "hence",
  "must", "might", "shall", "each", "any", "few", "own", "once", "soon",
  "people", "person", "believe", "think", "argue", "claim", "contend", "suggest",
  "agree", "disagree", "extent", "opinion", "view", "views", "discuss", "both",
  "side", "sides", "question", "topic", "essay", "draft", "writing", "speaking",
  "task", "prompt", "ielts", "nowadays", "today", "modern", "rapid", "development",
  "important", "problem", "issue", "good", "better", "best", "bad", "worse", "worst",
  "great", "greater", "useful", "helpful", "easier", "faster", "cleaner", "convenient",
  "much", "less", "fewer", "often", "usually", "typically", "always", "never", "still",
  "already", "even", "rather", "instead", "however", "therefore", "consequently",
  "ultimately", "admittedly", "furthermore", "moreover", "nevertheless", "although",
  "though", "whereas", "while", "because", "since", "unless", "until", "whether",
  "despite", "firstly", "secondly", "thirdly", "finally", "overall", "nutshell",
  "other", "another", "different", "same", "certain", "various", "several",
  "make", "making", "take", "taking", "took", "give", "giving", "gave",
  "does", "doing", "did", "done", "been", "being", "become", "becoming", "became",
  "remain", "remaining", "seem", "seeming", "need", "want", "help", "helping",
  "allow", "allowing", "create", "creating", "offer", "offering", "provide", "providing",
  "support", "supporting", "require", "requiring", "include", "including",
  "consider", "considering", "decide", "deciding", "keep", "keeping", "play", "playing",
  "bring", "bringing", "show", "showing", "find", "finding", "know", "knowing",
  "feel", "feeling", "live", "living", "use", "using", "used", "get", "getting",
  "time", "times", "year", "years", "future", "past", "present", "long", "short", "term",
  "high", "low", "big", "large", "small", "wide", "wider", "full", "quick", "quickly",
  "rapidly", "immediately", "briefly", "gradually", "steadily", "directly", "primarily",
  "mainly", "largely", "mostly", "simply", "clearly", "really", "actually", "way", "part",
  "point", "fact", "case", "hand", "example", "instance", "reason", "result", "effect",
  "impact", "benefit", "factor", "change", "solution", "approach", "choice", "option",
  "thing", "well", "again", "away", "back", "down", "here", "over", "under", "without",
  "between", "among", "around", "across", "through", "during", "before", "after",
  "against", "toward", "within", "every", "coin", "double", "edged", "sword", "denying",
  "heated", "sparked", "concerned", "stand", "last", "least", "carry", "buy",
  "government", "money", "spend", "spending", "build", "building",
  "family", "citizen", "resident", "authority", "society", "country", "nation",
  "world", "life", "daily", "community", "area", "place", "region",
  "district", "expand", "expanding", "invest", "investing", "undermine", "alleviate",
  "chronic", "demand", "induced",
  "encourage", "encouraging", "encouraged", "focus", "focusing", "focused",
  "prefer", "preferring", "preferred", "favour", "favor", "promote", "promoting", "promoted",
  "test", "demo", "fixture", "sample", "custom", "fresh", "attempt", "version",
  "second", "first", "third",
]);

function stemTopicToken(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies") && word.length >= 5) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length >= 6) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length >= 5) return word.slice(0, -2);
  if (word.endsWith("es") && word.length >= 5 && /(?:s|x|z|ch|sh)es$/u.test(word)) {
    return word.slice(0, -2);
  }
  if (word.endsWith("s") && !word.endsWith("ss") && word.length >= 4) return word.slice(0, -1);
  return word;
}

function collectTopicStems(
  text: string,
  stopWords: ReadonlySet<string>,
  minLength: number,
  into: Set<string>,
): void {
  const tokens = text.toLowerCase().match(/[a-z]+/gu) ?? [];
  for (const token of tokens) {
    if (token.length < minLength || stopWords.has(token)) continue;
    const stem = stemTopicToken(token);
    if (stem.length < 3 || stopWords.has(stem)) continue;
    into.add(stem);
  }
}

type PromptTopicSpec = {
  readonly keywords: ReadonlySet<string>;
  readonly contrastFacets: readonly [ReadonlySet<string>, ReadonlySet<string>] | null;
  readonly fromPromptStatement: boolean;
};

const PROMPT_CONTRAST_SPLIT = /\b(?:instead\s+of|rather\s+than|versus|vs\.?)\b/iu;
const PROMPT_ADVERSATIVE_SPLIT = /(?:,\s*\b(?:while|whereas)\b|\b(?:while\s+others|whereas\s+others|whereas)\b)/iu;
const PROMPT_NEXT_VIEW_OPENER =
  /^\s*(?:others|other\s+people|other\s+citizens|however\s*,?\s*others|on\s+the\s+other\s+hand|in\s+contrast|by\s+contrast|conversely|alternatively)\b/iu;
const PROMPT_BOILERPLATE_INSTRUCTION =
  /^\s*(?:discuss\s+both|to\s+what\s+extent|do\s+you\s+agree|what\s+are\s+the\s+(?:causes|reasons|solutions|advantages|disadvantages)|give\s+reasons\s+for\s+your\s+answer|include\s+any\s+relevant\s+examples)/iu;
const PROMPT_BOILERPLATE_QUESTION_OR =
  /\b(?:agree\s+or\s+disagree|advantages\s+or\s+disadvantages|positive\s+or\s+negative|good\s+or\s+bad|benefits\s+or\s+drawbacks|merits\s+or\s+demerits)\b/iu;
const PROMPT_CHOICE_SIGNAL = /\b(?:should|whether|prefer|better\s+to|choose)\b|\?\s*$/iu;

function narrowAdjacentModifiers(
  text: string,
  sharedTerms: ReadonlySet<string>,
  distinctive: ReadonlySet<string>,
): ReadonlySet<string> {
  if (sharedTerms.size === 0 || distinctive.size <= 1) return distinctive;
  const tokens = (text.toLowerCase().match(/[a-z]+/gu) ?? []).map((tok) => stemTopicToken(tok));
  const adjacent = new Set<string>();
  for (let i = 1; i < tokens.length; i += 1) {
    if (sharedTerms.has(tokens[i]!)) {
      const prev = tokens[i - 1]!;
      if (distinctive.has(prev)) {
        adjacent.add(prev);
      }
    }
  }
  return adjacent.size > 0 ? adjacent : distinctive;
}

function buildContrastFacetsFromPair(
  leftText: string,
  rightText: string,
): readonly [ReadonlySet<string>, ReadonlySet<string>] | null {
  if (!leftText.trim() || !rightText.trim()) return null;
  const rawLeft = new Set<string>();
  const rawRight = new Set<string>();
  collectTopicStems(leftText, TOPIC_SCAFFOLD_STOP_WORDS, 3, rawLeft);
  collectTopicStems(rightText, TOPIC_SCAFFOLD_STOP_WORDS, 3, rawRight);
  if (rawLeft.size === 0 || rawRight.size === 0) return null;

  // Subtract terms shared across both sides (e.g. "housing" in "public housing vs private housing")
  // so a one-sided essay cannot satisfy both poles via the shared head noun.
  const sharedTerms = new Set([...rawLeft].filter((term) => rawRight.has(term)));
  const distinctiveLeft = new Set([...rawLeft].filter((term) => !rawRight.has(term)));
  const distinctiveRight = new Set([...rawRight].filter((term) => !rawLeft.has(term)));

  if (sharedTerms.size > 0 && (distinctiveLeft.size === 0 || distinctiveRight.size === 0)) {
    return null;
  }

  const left = narrowAdjacentModifiers(
    leftText,
    sharedTerms,
    distinctiveLeft.size > 0 ? distinctiveLeft : rawLeft,
  );
  const right = narrowAdjacentModifiers(
    rightText,
    sharedTerms,
    distinctiveRight.size > 0 ? distinctiveRight : rawRight,
  );

  return left.size > 0 && right.size > 0 ? [left, right] : null;
}

function extractContrastFacets(
  trimmedStatement: string,
): readonly [ReadonlySet<string>, ReadonlySet<string>] | null {
  const sentences = (trimmedStatement.match(/[^.?!;]+(?:[.?!;]+|$)/gu) ?? [trimmedStatement])
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  // Pass 1: explicit contrast marker ("instead of", "rather than", "versus", "vs.") in any sentence.
  for (const sentence of sentences) {
    const splitParts = sentence.split(PROMPT_CONTRAST_SPLIT);
    if (splitParts.length >= 2) {
      const facets = buildContrastFacetsFromPair(splitParts[0]!, splitParts.slice(1).join(" "));
      if (facets) return facets;
    }
  }

  // Pass 2: intra-sentence adversative contrast ("..., while others ...", "whereas ...").
  for (const sentence of sentences) {
    if (PROMPT_BOILERPLATE_INSTRUCTION.test(sentence)) continue;
    const splitParts = sentence.split(PROMPT_ADVERSATIVE_SPLIT);
    if (splitParts.length >= 2) {
      const facets = buildContrastFacetsFromPair(splitParts[0]!, splitParts.slice(1).join(" "));
      if (facets) return facets;
    }
  }

  // Pass 3: cross-sentence two-view prompts ("Some people ... . Others ... .").
  for (let i = 0; i < sentences.length - 1; i += 1) {
    const current = sentences[i]!;
    const next = sentences[i + 1]!;
    if (PROMPT_BOILERPLATE_INSTRUCTION.test(current) || PROMPT_BOILERPLATE_INSTRUCTION.test(next)) {
      continue;
    }
    if (PROMPT_NEXT_VIEW_OPENER.test(next)) {
      const facets = buildContrastFacetsFromPair(current, next);
      if (facets) return facets;
    }
  }

  // Pass 4: choice-question "or" split ("Should governments subsidize public housing or encourage private housing development?").
  for (const sentence of sentences) {
    if (
      PROMPT_BOILERPLATE_INSTRUCTION.test(sentence) ||
      PROMPT_BOILERPLATE_QUESTION_OR.test(sentence) ||
      !PROMPT_CHOICE_SIGNAL.test(sentence)
    ) {
      continue;
    }
    const orMatches = [...sentence.matchAll(/\bor\b/giu)];
    for (let i = orMatches.length - 1; i >= 0; i -= 1) {
      const match = orMatches[i]!;
      const index = match.index ?? -1;
      if (index <= 0) continue;
      const leftText = sentence.slice(0, index);
      const rightText = sentence.slice(index + match[0].length);
      const facets = buildContrastFacetsFromPair(leftText, rightText);
      if (facets) return facets;
    }
  }

  return null;
}

function extractPromptTopicSpec(
  promptStatement: string | undefined,
  promptId: string,
  targets: readonly IeltsUpgradeTarget[],
  baselineProse: readonly string[],
  samePrompt: boolean,
): PromptTopicSpec {
  const trimmedStatement = promptStatement?.trim() ?? "";
  if (trimmedStatement) {
    const keywords = new Set<string>();
    collectTopicStems(trimmedStatement, TOPIC_SCAFFOLD_STOP_WORDS, 3, keywords);
    collectTopicStems(promptId, TOPIC_SCAFFOLD_STOP_WORDS, 3, keywords);
    if (keywords.size === 0) {
      collectTopicStems(trimmedStatement, STOP_WORDS, 3, keywords);
      collectTopicStems(promptId, STOP_WORDS, 3, keywords);
    }

    const contrastFacets = extractContrastFacets(trimmedStatement);
    return { keywords, contrastFacets, fromPromptStatement: true };
  }

  // Without an explicit promptStatement, rely on promptId + topical targets first
  // (never diluting with incidental baselineProse nouns unless promptId + targets are empty).
  const strict = new Set<string>();
  collectTopicStems(promptId, TOPIC_SCAFFOLD_STOP_WORDS, 3, strict);
  for (const target of targets) {
    for (const pattern of target.targetPatterns) {
      collectTopicStems(pattern, TOPIC_SCAFFOLD_STOP_WORDS, 3, strict);
    }
  }
  if (strict.size === 0 && samePrompt) {
    collectTopicStems(baselineProse.join(" "), TOPIC_SCAFFOLD_STOP_WORDS, 4, strict);
  }
  if (strict.size > 0) {
    return { keywords: strict, contrastFacets: null, fromPromptStatement: false };
  }

  const fallback = new Set<string>();
  collectTopicStems(promptId, STOP_WORDS, 3, fallback);
  if (samePrompt) {
    collectTopicStems(baselineProse.join(" "), STOP_WORDS, 4, fallback);
  }
  return { keywords: fallback, contrastFacets: null, fromPromptStatement: false };
}

type TopicRelevanceAssessment = {
  readonly isOffTopic: boolean;
  readonly isTangential: boolean;
  readonly keywordCount: number;
  readonly overlapCount: number;
};

function assessPromptTopicRelevance(
  spec: PromptTopicSpec,
  revisedProse: readonly string[],
  revisedParagraphs: readonly (readonly GroundedSentence[])[],
  revisedWordCount: number,
): TopicRelevanceAssessment {
  const keywordCount = spec.keywords.size;
  if (keywordCount === 0 || revisedWordCount === 0) {
    return { isOffTopic: false, isTangential: false, keywordCount, overlapCount: 0 };
  }

  const revisedStems = new Set<string>();
  collectTopicStems(revisedProse.join(" "), STOP_WORDS, 3, revisedStems);
  let overlapCount = 0;
  for (const keyword of spec.keywords) {
    if (revisedStems.has(keyword)) overlapCount += 1;
  }

  if (overlapCount === 0) {
    return { isOffTopic: true, isTangential: false, keywordCount, overlapCount };
  }

  // Count paragraph, sentence, and word-share engagement with prompt keywords
  // across BOTH short (60–159 words) and full essays so stuffing prompt facet words
  // into a single throwaway sentence cannot bypass off-topic caps.
  let nonEmptyParagraphs = 0;
  let paragraphsWithHit = 0;
  let totalSentences = 0;
  let sentencesWithHit = 0;
  let totalSentenceWords = 0;
  let wordsInOnTopicSentences = 0;
  for (const [pIndex, prose] of revisedProse.entries()) {
    if (countProseWords(prose) === 0) continue;
    nonEmptyParagraphs += 1;
    const pStems = new Set<string>();
    collectTopicStems(prose, STOP_WORDS, 3, pStems);
    if ([...spec.keywords].some((kw) => pStems.has(kw))) {
      paragraphsWithHit += 1;
    }
    for (const sentence of revisedParagraphs[pIndex] ?? []) {
      const sentenceWords = countProseWords(sentence.text);
      if (sentenceWords === 0) continue;
      totalSentences += 1;
      totalSentenceWords += sentenceWords;
      const sStems = new Set<string>();
      collectTopicStems(sentence.text, STOP_WORDS, 3, sStems);
      let sentenceTopicHits = 0;
      for (const kw of spec.keywords) {
        if (sStems.has(kw)) sentenceTopicHits += 1;
      }
      if (sentenceTopicHits > 0) {
        sentencesWithHit += 1;
        // Cap credited on-topic words per hitting sentence so stuffing keywords into one
        // run-on sentence cannot inflate on-topic word share across unrelated filler.
        wordsInOnTopicSentences += Math.min(sentenceWords, sentenceTopicHits * 12 + 6);
      }
    }
  }

  const sentenceHitRatio = totalSentences > 0 ? sentencesWithHit / totalSentences : 0;
  const onTopicWordRatio =
    totalSentenceWords > 0 ? wordsInOnTopicSentences / totalSentenceWords : 0;
  const meetsMultiSentenceRatio =
    totalSentences < 2 ||
    (totalSentences === 2
      ? sentencesWithHit === 2
      : sentencesWithHit >= 2 && sentenceHitRatio >= 0.4);

  if (revisedWordCount < 160) {
    const minShortMatches = keywordCount >= 2 ? 2 : 1;
    if (overlapCount < minShortMatches) {
      return { isOffTopic: true, isTangential: false, keywordCount, overlapCount };
    }
    const isSingleSentenceOrLowShareStuffing =
      (revisedWordCount >= 60 &&
        (sentencesWithHit < 2 || !meetsMultiSentenceRatio || onTopicWordRatio < 0.35)) ||
      (totalSentences >= 3 && (sentencesWithHit < 2 || sentenceHitRatio < 0.4));
    if (isSingleSentenceOrLowShareStuffing) {
      return { isOffTopic: true, isTangential: false, keywordCount, overlapCount };
    }
    if (revisedWordCount >= 60 && spec.contrastFacets) {
      const [leftFacet, rightFacet] = spec.contrastFacets;
      const coversLeft = [...leftFacet].some((kw) => revisedStems.has(kw));
      const coversRight = [...rightFacet].some((kw) => revisedStems.has(kw));
      if (!coversLeft || !coversRight) {
        return { isOffTopic: false, isTangential: true, keywordCount, overlapCount };
      }
    }
    return { isOffTopic: false, isTangential: false, keywordCount, overlapCount };
  }

  const requiredMatches = spec.fromPromptStatement
    ? Math.min(keywordCount, Math.max(3, Math.ceil(keywordCount * 0.35)))
    : Math.min(
        keywordCount,
        keywordCount >= 6 ? Math.max(3, Math.ceil(keywordCount * 0.25)) : keywordCount >= 5 ? 2 : 1,
      );
  const hasSufficientSpread =
    nonEmptyParagraphs >= 2 ? paragraphsWithHit >= 2 : sentencesWithHit >= 2;
  const hasSufficientSentenceShare =
    sentencesWithHit >= 2 && meetsMultiSentenceRatio && onTopicWordRatio >= 0.35;

  if (overlapCount < requiredMatches || !hasSufficientSpread || !hasSufficientSentenceShare) {
    return { isOffTopic: true, isTangential: false, keywordCount, overlapCount };
  }

  if (spec.contrastFacets) {
    const [leftFacet, rightFacet] = spec.contrastFacets;
    const coversLeft = [...leftFacet].some((kw) => revisedStems.has(kw));
    const coversRight = [...rightFacet].some((kw) => revisedStems.has(kw));
    if (!coversLeft || !coversRight) {
      return { isOffTopic: false, isTangential: true, keywordCount, overlapCount };
    }
  }

  return { isOffTopic: false, isTangential: false, keywordCount, overlapCount };
}

const CLAUSE_VERB_CUE =
  /\b(is|are|was|were|be|been|being|am|can|could|may|might|must|shall|should|will|would|do|does|did|have|has|had|make|makes|made|offer|offers|offered|help|helps|helped|deliver|delivers|delivered|address|addresses|addressed|encourage|encourages|encouraged|undermine|undermines|undermined|resolve|resolves|resolved|require|requires|required|support|supports|supported|reduce|reduces|reduced|improve|improves|improved|provide|provides|provided|create|creates|created|allow|allows|allowed|show|shows|showed|suggest|suggests|contend|believe|argue|think|claim|need|needs|face|faces|lack|lacks|anchor|anchors|shift|shifts|ease|eases|cut|cuts|lower|lowers|curb|curbs|build|builds|spend|spends|invest|invests|expand|expands|rely|relies|trigger|triggers|sustain|sustains|prioritise|prioritises|prioritize|prioritizes|remain|remains|become|becomes|became|dominate|dominates|transport|transports|pair|pairs|pairing)\b/iu;

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeForEquality(paragraphs: readonly string[]): string {
  return paragraphs
    .map((p) => p.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD_TOKEN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

function tokenizeWords(text: string): string[] {
  return text.toLowerCase().match(WORD_TOKEN) ?? [];
}

function patternRegex(pattern: string, flags: string): RegExp | undefined {
  const trimmed = pattern.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(/\s+/).map(escapeRegExp);
  return new RegExp("(?<![\\p{L}\\p{N}])" + parts.join("\\s+") + "(?![\\p{L}\\p{N}])", flags);
}

function matchesPattern(text: string, pattern: string): boolean {
  return patternRegex(pattern, "iu")?.test(text) ?? false;
}

function findPatternRanges(text: string, pattern: string): MatchRange[] {
  const regex = patternRegex(pattern, "giu");
  if (!regex) return [];
  return Array.from(text.matchAll(regex), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function findMatchedPatterns(
  paragraphs: readonly string[],
  patterns: readonly string[] | undefined,
): { matched: string[]; paragraphIndices: number[] } {
  if (!patterns || patterns.length === 0) {
    return { matched: [], paragraphIndices: [] };
  }
  const matched = new Set<string>();
  const indices = new Set<number>();

  paragraphs.forEach((paragraph, index) => {
    for (const pattern of patterns) {
      if (matchesPattern(paragraph, pattern)) {
        matched.add(pattern);
        indices.add(index);
      }
    }
  });

  return {
    matched: [...matched],
    paragraphIndices: [...indices].sort((a, b) => a - b),
  };
}

function extractMeaningfulTerms(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}]{4,}(?:-[\p{L}]{2,})*/gu) ?? [];
  return new Set(words.filter((word) => !STOP_WORDS.has(word)));
}

function isLowEntropySentence(sentence: string): boolean {
  const words = tokenizeWords(sentence);
  if (words.length < 8) return false;
  const unique = new Set(words);
  if (unique.size / words.length < 0.45) return true;

  const contentCounts = new Map<string, number>();
  for (const w of words) {
    if (w.length < 3 || STOP_WORDS.has(w)) continue;
    const count = (contentCounts.get(w) ?? 0) + 1;
    contentCounts.set(w, count);
    if (count >= 4 || (words.length >= 12 && count / words.length >= 0.25)) {
      return true;
    }
  }
  return false;
}

/**
 * Detects repetitive filler padding (word spam, low lexical diversity, repeated
 * 3-grams, or copy-pasted identical sentences) across the draft or within any paragraph.
 */
export function detectLowEntropyStuffing(
  paragraphs: readonly string[],
  segmentedParagraphs: readonly (readonly GroundedSentence[])[] = paragraphs.map(segmentIeltsText),
): boolean {
  const fullText = paragraphs.join(" ");
  const allWords = tokenizeWords(fullText);
  if (allWords.length >= 60) {
    const overallTtr = new Set(allWords).size / allWords.length;
    if (overallTtr < 0.36) return true;
  }

  // Repeated 3-gram stuffing across essay or inside any paragraph.
  const globalTrigrams = new Map<string, number>();
  const seenSentences = new Map<string, number>();

  for (const [index, paragraph] of paragraphs.entries()) {
    const words = tokenizeWords(paragraph);
    if (words.length >= 18) {
      const paraTtr = new Set(words).size / words.length;
      if (paraTtr < 0.38) return true;
    }

    // Single content-word spam inside a paragraph.
    const paraCounts = new Map<string, number>();
    for (const w of words) {
      if (w.length < 3 || STOP_WORDS.has(w)) continue;
      const c = (paraCounts.get(w) ?? 0) + 1;
      paraCounts.set(w, c);
      if (c >= 6 || (words.length >= 12 && c / words.length >= 0.22)) {
        return true;
      }
    }

    const paraTrigrams = new Map<string, number>();
    for (let i = 0; i <= words.length - 3; i += 1) {
      const trigram = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      const pCount = (paraTrigrams.get(trigram) ?? 0) + 1;
      paraTrigrams.set(trigram, pCount);
      if (pCount >= 3) return true;

      const gCount = (globalTrigrams.get(trigram) ?? 0) + 1;
      globalTrigrams.set(trigram, gCount);
      if (gCount >= 4) return true;
    }

    for (const sentence of segmentedParagraphs[index] ?? []) {
      const sWords = tokenizeWords(sentence.text);
      if (sWords.length >= 5) {
        const key = sWords.join(" ");
        const sCount = (seenSentences.get(key) ?? 0) + 1;
        seenSentences.set(key, sCount);
        if (sCount >= 2) return true;
      }
    }
  }

  return false;
}

function isMechanicalKeywordSentence(
  clause: CoreClause,
  allTargetPatterns: readonly string[],
): boolean {
  if (!clause.substantive) return true;

  // Count distinct evidence even when several target aliases overlap.
  const candidates = allTargetPatterns
    .flatMap((pattern) =>
      findPatternRanges(clause.text, pattern).map((range) => ({ ...range, pattern })),
    )
    .sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const distinctMatches: MatchRange[] = [];
  const matchedPatterns = new Set<string>();
  let matchedWordCount = 0;
  for (const match of candidates) {
    if (matchedPatterns.has(match.pattern) || distinctMatches.some((other) => rangesOverlap(match, other))) {
      continue;
    }
    distinctMatches.push(match);
    matchedPatterns.add(match.pattern);
    matchedWordCount += countProseWords(clause.text.slice(match.start, match.end));
  }

  return (
    (matchedPatterns.size >= 3 && matchedWordCount / clause.tokens.length >= 0.45) ||
    (matchedPatterns.size >= 2 && clause.tokens.length - matchedWordCount <= 4)
  );
}

function normalizeSentenceTokenKey(sentence: string): string {
  return tokenizeWords(sentence).join(" ");
}

function tokenJaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function longestContiguousCommonRun(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        const len = (prev[j - 1] ?? 0) + 1;
        curr[j] = len;
        if (len > best) best = len;
      }
    }
    prev = curr;
  }
  return best;
}

/**
 * Removes verbless comma-list padding at the edges and between verbal segments.
 * A single fronted marker, prepositional phrase or interior aside can be meaningful.
 */
function selectCoreParts(segments: readonly GroundedTextSpan[]): readonly GroundedTextSpan[] {
  if (segments.length <= 1) return segments;

  let end = segments.length;
  while (end > 1 && !CLAUSE_VERB_CUE.test(segments[end - 1]!.text)) {
    end -= 1;
  }

  let start = 0;
  let leadingVerbless = 0;
  while (
    start + leadingVerbless < end &&
    !CLAUSE_VERB_CUE.test(segments[start + leadingVerbless]!.text)
  ) {
    leadingVerbless += 1;
  }
  if (leadingVerbless >= 2 && start + leadingVerbless < end) {
    start += leadingVerbless;
  }

  const core: GroundedTextSpan[] = [];
  for (let i = start; i < end;) {
    const segment = segments[i]!;
    if (CLAUSE_VERB_CUE.test(segment.text)) {
      core.push(segment);
      i += 1;
      continue;
    }

    let next = i + 1;
    while (next < end && !CLAUSE_VERB_CUE.test(segments[next]!.text)) next += 1;
    if (next === i + 1) core.push(segment);
    i = next;
  }
  return core;
}

type CoreClause = {
  readonly raw: GroundedClause;
  readonly parts: readonly GroundedTextSpan[];
  readonly text: string;
  readonly tokens: readonly string[];
  readonly tokenRanges: readonly MatchRange[];
  readonly substantive: boolean;
};

function prepareCoreClause(clause: GroundedClause): CoreClause {
  const parts = selectCoreParts(clause.parts);
  const text = parts.map((part) => part.text).join(", ");
  const words = parts.flatMap((part) => Array.from(part.text.matchAll(WORD_TOKEN), (match) => {
    const start = part.startOffset + match.index;
    return { token: match[0].toLowerCase(), start, end: start + match[0].length };
  }));
  const tokens = words.map(({ token }) => token);
  return {
    raw: clause,
    parts,
    text,
    tokens,
    tokenRanges: words,
    substantive: tokens.length >= 7 && CLAUSE_VERB_CUE.test(text) && !isLowEntropySentence(text),
  };
}

/**
 * Checks whether an elementary clause is substantively changed from every
 * baseline elementary clause (regardless of baseline length, including short
 * < 6-word baselines). Preprocessed tokens ignore comma-list padding.
 */
function isClauseSubstantivelyChangedFromBaseline(
  words: readonly string[],
  baselineCoreClauseKeys: ReadonlySet<string>,
  baselineCoreClauseTokens: readonly (readonly string[])[],
): boolean {
  if (!words.length || baselineCoreClauseKeys.has(words.join(" "))) return false;
  const wordSet = new Set(words);

  for (const baseWords of baselineCoreClauseTokens) {
    if (baseWords.length === 0) continue;
    if (tokenJaccardSimilarity(words, baseWords) >= 0.80) {
      return false;
    }

    // Check containment + contiguous run for ALL baseline clauses >= 3 words
    // (closing the short-baseline < 6-word padding loophole).
    if (baseWords.length >= 3) {
      let containedCount = 0;
      for (const bw of baseWords) {
        if (wordSet.has(bw)) containedCount += 1;
      }
      const containment = containedCount / baseWords.length;
      const minRun =
        baseWords.length <= 5
          ? baseWords.length
          : Math.min(6, Math.ceil(baseWords.length * 0.6));
      if (
        containment >= 0.85 &&
        longestContiguousCommonRun(words, baseWords) >= minRun
      ) {
        return false;
      }
    }
  }
  return true;
}

type LocalContextWindow = {
  readonly pre: readonly string[];
  readonly post: readonly string[];
  readonly full: readonly string[];
};

function getPatternLocalWindow(clause: CoreClause, range: MatchRange): LocalContextWindow {
  const first = clause.tokenRanges.findIndex(({ end }) => end > range.start);
  const before = first < 0 ? clause.tokens.length : first;
  const after = clause.tokenRanges.findIndex(({ start }) => start >= range.end);
  const pre = clause.tokens.slice(Math.max(0, before - 4), before);
  const post = after < 0 ? [] : clause.tokens.slice(after, after + 4);
  return { pre, post, full: [...pre, ...post] };
}

function findClausePatternRanges(clause: CoreClause, pattern: string): MatchRange[] {
  return findPatternRanges(clause.raw.text, pattern).map(({ start, end }) => ({
    start: clause.raw.startOffset + start,
    end: clause.raw.startOffset + end,
  }));
}

function endsWithTokens(
  haystack: readonly string[],
  suffix: readonly string[],
): boolean {
  if (suffix.length === 0 || haystack.length < suffix.length) return false;
  const offset = haystack.length - suffix.length;
  for (let i = 0; i < suffix.length; i += 1) {
    if (haystack[offset + i] !== suffix[i]) return false;
  }
  return true;
}

function startsWithTokens(
  haystack: readonly string[],
  prefix: readonly string[],
): boolean {
  if (prefix.length === 0 || haystack.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (haystack[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Checks whether the occurrence sits inside the same four-word neighborhood
 * on either side of a baseline match,
 * including matches that preserve the immediate subject and predicate.
 */
function isPatternLocalContextCopiedFromBaseline(
  cw: LocalContextWindow,
  baselineWindows: readonly LocalContextWindow[],
): boolean {
  return baselineWindows.some((bw) => {
    if (tokenJaccardSimilarity(cw.full, bw.full) >= 0.75) return true;
    if (
      cw.full.length >= 2 &&
      longestContiguousCommonRun(cw.full, bw.full) >= Math.min(4, cw.full.length)
    ) {
      return true;
    }
    // Exact pre-target subject+verb preserved while post-target only adds verbless tail:
    if (
      bw.pre.length >= 2 &&
      endsWithTokens(cw.pre, bw.pre) &&
      (bw.post.length === 0
        ? !CLAUSE_VERB_CUE.test(cw.post.join(" "))
        : tokenJaccardSimilarity(cw.post, bw.post) >= 0.75)
    ) {
      return true;
    }
    // Symmetrically, exact post-target predicate preserved while pre-target adds no verb:
    return bw.post.length >= 2 && startsWithTokens(cw.post, bw.post) &&
      (bw.pre.length === 0
        ? !CLAUSE_VERB_CUE.test(cw.pre.join(" "))
        : tokenJaccardSimilarity(cw.pre, bw.pre) >= 0.75);
  });
}

function assessSubstantiveRevision(
  draft1: IeltsEssayDraft,
  draft2: IeltsEssayDraft,
  revisedClauses: readonly (CoreClause & { readonly changed: boolean })[],
): boolean {
  const norm1 = normalizeForEquality(draft1.paragraphs);
  const norm2 = normalizeForEquality(draft2.paragraphs);
  if (!norm2 || norm1 === norm2) return false;

  // Compare paragraphs using punctuation-stripped tokens so "." -> "!" swaps never count.
  const maxParagraphs = Math.max(draft1.paragraphs.length, draft2.paragraphs.length);
  let changedParagraphs = 0;
  for (let i = 0; i < maxParagraphs; i += 1) {
    const k1 = normalizeSentenceTokenKey(draft1.paragraphs[i] ?? "");
    const k2 = normalizeSentenceTokenKey(draft2.paragraphs[i] ?? "");
    if (k1 !== k2) changedParagraphs += 1;
  }
  if (changedParagraphs === 0) return false;

  const substantiveClauses = revisedClauses.filter((clause) => clause.substantive);
  const rewrittenSubstantiveCoreClauses = substantiveClauses.filter((clause) => clause.changed);

  const rewrittenRatio =
    revisedClauses.length > 0
      ? rewrittenSubstantiveCoreClauses.length / revisedClauses.length
      : 0;

  // Only count new vocabulary that lives inside genuinely rewritten core clauses
  // (never appended colon/semicolon/dash/comma bare noun lists).
  const terms1 = extractMeaningfulTerms(draft1.paragraphs.join(" "));
  const substantiveRevisedText = rewrittenSubstantiveCoreClauses.map((clause) => clause.text).join(" ");
  const substantiveTerms2 = extractMeaningfulTerms(substantiveRevisedText);
  const newlyAddedSubstantiveTerms = [...substantiveTerms2].filter(
    (t) => !terms1.has(t),
  );

  const allClauseTerms2 = extractMeaningfulTerms(
    substantiveClauses.map((clause) => clause.text).join(" "),
  );
  const removedTerms = [...terms1].filter((t) => !allClauseTerms2.has(t));
  const unionSize = new Set([...terms1, ...allClauseTerms2]).size;
  const jaccardDistance =
    unionSize > 0
      ? (newlyAddedSubstantiveTerms.length + removedTerms.length) / unionSize
      : 0;

  return (
    rewrittenSubstantiveCoreClauses.length >= 2 &&
    rewrittenRatio >= 0.25 &&
    newlyAddedSubstantiveTerms.length >= 12 &&
    (jaccardDistance >= 0.18 || changedParagraphs >= 2)
  );
}

export function diffEssayParagraphs(
  draft1Paragraphs: readonly string[],
  draft2Paragraphs: readonly string[],
): IeltsParagraphDiff[] {
  const maxLen = Math.max(draft1Paragraphs.length, draft2Paragraphs.length);
  const diffs: IeltsParagraphDiff[] = [];
  const draft1Prose = maskIeltsParagraphs(draft1Paragraphs);
  const draft2Prose = maskIeltsParagraphs(draft2Paragraphs);

  for (let i = 0; i < maxLen; i += 1) {
    const p1 = draft1Paragraphs[i] ?? "";
    const p2 = draft2Paragraphs[i] ?? "";
    const norm1 = normalizeText(p1);
    const norm2 = normalizeText(p2);

    let status: IeltsParagraphDiff["status"];
    if (!norm1 && norm2) {
      status = "added";
    } else if (norm1 && !norm2) {
      status = "removed";
    } else if (norm1 === norm2) {
      status = "unchanged";
    } else {
      status = "revised";
    }

    const prose1 = draft1Prose[i] ?? "";
    const prose2 = draft2Prose[i] ?? "";
    const terms1 = extractMeaningfulTerms(prose1);
    const terms2 = extractMeaningfulTerms(prose2);
    const addedTerms = [...terms2].filter((t) => !terms1.has(t)).slice(0, 8);
    const removedTerms = [...terms1].filter((t) => !terms2.has(t)).slice(0, 8);

    diffs.push({
      paragraphIndex: i,
      draft1Text: p1,
      draft2Text: p2,
      status,
      wordDelta: countProseWords(prose2) - countProseWords(prose1),
      addedTerms,
      removedTerms,
    });
  }

  return diffs;
}

export type AnalyzeCrossDraftTransferInput = {
  readonly draft1: IeltsEssayDraft;
  readonly draft2: IeltsEssayDraft;
  readonly targets: readonly IeltsUpgradeTarget[];
  readonly promptStatement?: string;
};

type TransferAnalysis = Omit<IeltsCrossDraftTransferReport, "summary" | "memorizedTemplateHits"> & {
  readonly summary: Omit<IeltsCrossDraftTransferReport["summary"], "masteryQualified">;
  readonly memorizedTemplateHits: ReturnType<typeof detectMemorizedTemplates>;
};

function finalizeTransferReport(
  analysis: TransferAnalysis,
  masteryQualified: boolean,
): IeltsCrossDraftTransferReport {
  return { ...analysis, summary: { ...analysis.summary, masteryQualified } };
}

/** Checks revisions for contextual target transfer and resolves Writing mastery eligibility. */
export function analyzeCrossDraftTransfer(
  input: AnalyzeCrossDraftTransferInput,
): IeltsCrossDraftTransferReport {
  const revisedProse = maskIeltsParagraphs(input.draft2.paragraphs);
  const wordCount = countProseWords(revisedProse.join("\n"));
  const { report } = analyzeTransfer(input, false, revisedProse, revisedProse.map(segmentIeltsText), wordCount);
  const { masteryQualified } = resolveIeltsEpistemicStatus({
    draftVersion: input.draft2.version,
    assisted: input.draft2.assisted,
    crossDraftTransferVerified: report.summary.meetsCrossDraftVerification,
    memorizedTemplateHits: report.memorizedTemplateHits,
    wordCount,
    disqualificationReason: report.summary.disqualificationReason,
  });
  return finalizeTransferReport(report, masteryQualified);
}

type WritingCandidate = MatchRange & {
  readonly paragraphIndex: number;
  readonly sentence: GroundedSentence;
  readonly pattern: string;
  readonly exclusiveKey: string;
  readonly citationBounds: MatchRange;
};

function analyzeTransfer(
  input: AnalyzeCrossDraftTransferInput,
  freshPromptConfirmed: boolean,
  revisedProse: readonly string[],
  revisedParagraphs: readonly (readonly GroundedSentence[])[],
  revisedWordCount: number,
): {
  report: TransferAnalysis;
  creditedOccurrences: ReadonlyMap<IeltsCriterion, WritingCandidate>;
  topicRelevance: TopicRelevanceAssessment;
} {
  const samePrompt = input.draft1.promptId === input.draft2.promptId;
  const lineage = getWritingTransferLineage(input.draft1, input.draft2);
  const advancingLineage = lineage === "advancing_revision";
  const freshPrompt = lineage === "fresh_prompt" && freshPromptConfirmed;
  const baselineProse = maskIeltsParagraphs(input.draft1.paragraphs);
  const hasBaselineText = baselineProse.some((paragraph) => countProseWords(paragraph) > 0);
  const canEvaluateTransfer = (advancingLineage || freshPrompt) && hasBaselineText;
  const targets = getUniqueWritingTargets(input.targets);

  const paragraphDiffs = diffEssayParagraphs(
    input.draft1.paragraphs,
    input.draft2.paragraphs,
  );
  const memorizedTemplateHits = detectMemorizedTemplates(input.draft2.paragraphs);
  const hasStuffing = hasMemorizedTemplateStuffing(memorizedTemplateHits);
  const hasLowEntropyStuffing = detectLowEntropyStuffing(revisedProse, revisedParagraphs);
  const baselineClauses = baselineProse
    .flatMap(segmentIeltsText)
    .flatMap((sentence) => sentence.clauses.map(prepareCoreClause));
  const baselineCoreClauseTokens = baselineClauses.map(({ tokens }) => tokens);
  const baselineCoreClauseKeys = new Set(
    baselineCoreClauseTokens.map((tokens) => tokens.join(" ")).filter(Boolean),
  );
  const allTargetPatterns = [...new Set(
    targets.flatMap((target) => target.targetPatterns.map(normalizeText)).filter(Boolean),
  )].sort();
  const baselineContexts = new Map(allTargetPatterns.map((pattern) => [pattern, baselineClauses.flatMap((clause) => {
    const droppedParts = clause.raw.parts.filter((part) => !clause.parts.includes(part));
    return findClausePatternRanges(clause, pattern)
      .filter((range) => !droppedParts.some((part) => rangesOverlap(range, { start: part.startOffset, end: part.endOffset })))
      .map((range) => getPatternLocalWindow(clause, range));
  })]));
  const revisedClauses = revisedParagraphs.flatMap((sentences, paragraphIndex) =>
    sentences.flatMap((sentence) => sentence.clauses.map((raw) => {
      const core = prepareCoreClause(raw);
      return {
        ...core,
        sentence,
        paragraphIndex,
        changed: core.substantive && isClauseSubstantivelyChangedFromBaseline(
          core.tokens,
          baselineCoreClauseKeys,
          baselineCoreClauseTokens,
        ),
        mechanical: isMechanicalKeywordSentence(core, allTargetPatterns),
        droppedParts: raw.parts.filter((part) => !core.parts.includes(part)),
      };
    })),
  );
  const hasSubstantiveRevision = assessSubstantiveRevision(
    { ...input.draft1, paragraphs: baselineProse },
    { ...input.draft2, paragraphs: revisedProse },
    revisedClauses,
  );
  let hasMechanicalKeywordPaste = false;

  const targetMatches = targets.map((target) => {
    const baseHit = findMatchedPatterns(baselineProse, target.targetPatterns);
    const rawRevHit = findMatchedPatterns(revisedProse, target.targetPatterns);
    const baseWeak = findMatchedPatterns(
      baselineProse,
      target.weakBaselinePatterns,
    );
    const revWeak = findMatchedPatterns(
      revisedProse,
      target.weakBaselinePatterns,
    );
    const revCliche = findMatchedPatterns(
      revisedProse,
      target.clichePatterns,
    );

    const candidates: WritingCandidate[] = [];
    let sawMechanical = false;
    let sawUnchanged = false;

    // Verify matches against the original text, excluding any stripped comma-list padding.
    for (const pattern of rawRevHit.matched) {
      const patternKey = normalizeText(pattern);
      const baselineContext = baselineContexts.get(patternKey)!;

      for (const clause of revisedClauses) {
        const rawRanges = findClausePatternRanges(clause, pattern);
        if (rawRanges.length === 0) continue;
        const ranges = rawRanges.filter((range) => !clause.droppedParts.some((part) =>
          rangesOverlap(range, { start: part.startOffset, end: part.endOffset }),
        ));
        if (ranges.length < rawRanges.length || clause.mechanical) {
          hasMechanicalKeywordPaste = true;
          sawMechanical = true;
        }
        if (ranges.length === 0 || clause.mechanical) continue;
        if (!clause.changed) {
          sawUnchanged = true;
          continue;
        }
        const copied = new Set(ranges.filter((range) =>
          isPatternLocalContextCopiedFromBaseline(getPatternLocalWindow(clause, range), baselineContext),
        ));
        if (copied.size > 0) sawUnchanged = true;
        for (const range of ranges) {
          if (copied.has(range)) continue;
          let { startOffset: citationStart, endOffset: citationEnd } = clause.sentence;
          for (const excluded of copied) {
            if (excluded.end <= range.start) citationStart = excluded.end;
            if (excluded.start >= range.end) {
              citationEnd = excluded.start;
              break;
            }
          }
          candidates.push({
            ...range,
            paragraphIndex: clause.paragraphIndex,
            sentence: clause.sentence,
            pattern,
            exclusiveKey: patternKey,
            citationBounds: { start: citationStart, end: citationEnd },
          });
        }
      }
    }
    return { target, baseHit, rawRevHit, baseWeak, revWeak, revCliche, candidates, sawMechanical, sawUnchanged };
  });

  // Evaluate prompt/topic relevance independently of target matches so generic
  // discourse connectors (e.g. "therefore", "consequently") on off-topic text
  // never receive transfer credit or bypass off-topic band caps.
  const topicSpec = extractPromptTopicSpec(
    input.promptStatement,
    input.draft2.promptId,
    targets,
    baselineProse,
    samePrompt,
  );
  const topicRelevance = assessPromptTopicRelevance(
    topicSpec,
    revisedProse,
    revisedParagraphs,
    revisedWordCount,
  );
  const isOffTopicOrTangential = topicRelevance.isOffTopic || topicRelevance.isTangential;

  const canAllocate = canEvaluateTransfer && hasSubstantiveRevision && !isOffTopicOrTangential;
  const eligibleTargets = targetMatches
    .filter(({ revCliche }) => canAllocate && revCliche.matched.length === 0)
    .sort((a, b) => compareText(a.target.criterion, b.target.criterion) || compareText(a.target.label, b.target.label));
  const candidatesById = new Map(eligibleTargets.map(({ target, candidates }) => [target.id, candidates]));
  const allocated = new Set(allocateIeltsSpans(candidatesById).values());
  const creditedOccurrences = new Map<IeltsCriterion, WritingCandidate>();

  const items: IeltsUpgradeTransferItem[] = targetMatches.map((match) => {
    const { target, baseHit, rawRevHit, baseWeak, revWeak, revCliche, candidates, sawMechanical, sawUnchanged } = match;
    const winner = candidates.find((candidate) => allocated.has(candidate));
    const matches = isOffTopicOrTangential
      ? []
      : canAllocate && revCliche.matched.length === 0
        ? (winner ? [winner] : [])
        : candidates;
    const revMatchedList = [...new Set(matches.map(({ pattern }) => pattern))];
    const revParagraphList = [...new Set(matches.map(({ paragraphIndex }) => paragraphIndex))].sort((a, b) => a - b);
    const matchedOnlyInMechanicalPaste = candidates.length === 0 && sawMechanical;
    const matchedOnlyInUnchangedSentence = candidates.length === 0 && !sawMechanical && sawUnchanged;
    const overlapsCreditedEvidence = canAllocate && candidates.length > 0 && !winner;

    let status: IeltsTransferStatus;
    let explanation: string;

    if (revCliche.matched.length > 0) {
      status = "memorized_cliche";
      explanation = `二稿中出现了模板套话（${revCliche.matched.join(" / ")}），需替换为贴合题干语境的原创表达。`;
    } else if (baseHit.matched.length > 0 && rawRevHit.matched.length === 0) {
      status = "regressed";
      explanation = `一稿原有的目标表达（${baseHit.matched.join(" / ")}）在改写中丢失，建议恢复并完善。`;
    } else if (
      revWeak.matched.length > baseWeak.matched.length &&
      revMatchedList.length === 0
    ) {
      status = "regressed";
      explanation = `二稿新增了偏笼统或薄弱表达（${revWeak.matched.join(" / ")}），尚未替换为目标升级结构。`;
    } else if (isOffTopicOrTangential) {
      status = "pending";
      explanation = candidates.length > 0 || rawRevHit.matched.length > 0
        ? "当前作答未实质性回应题干核心主题与争议维度，偏题文本中的衔接词或表达不计作有效迁移。"
        : "尚未在紧扣题干的论证语境中观察到目标表达，请先切题展开再尝试迁移。";
    } else if (!canEvaluateTransfer && revMatchedList.length > 0) {
      status = "pending";
      explanation = "跨稿迁移需在同一题目下推进稿件版本，新题作答需单独复核。";
    } else if (matchedOnlyInMechanicalPaste) {
      status = "pending";
      explanation = `仅检测到目标词组的机械拼贴或重复填充句（${rawRevHit.matched.join(" / ")}），需融入完整论证语境后再复核。`;
    } else if (matchedOnlyInUnchangedSentence || (revMatchedList.length > 0 && !hasSubstantiveRevision)) {
      status = "pending";
      explanation = `目标表达所在句子相对一稿未作实质性改写（或仅调整标点），暂不计作有效跨草稿迁移。`;
    } else if (winner) {
      status = "transferred";
      if (!creditedOccurrences.has(target.criterion)) creditedOccurrences.set(target.criterion, winner);
      const clearedWeak =
        baseWeak.matched.length > 0 && revWeak.matched.length < baseWeak.matched.length;
      explanation = clearedWeak
        ? `已成功替换为目标表达（${revMatchedList.join(" / ")}），并清除了原稿薄弱说法。`
        : `已在第 ${revParagraphList.map((idx) => idx + 1).join("、")} 段自然运用目标表达（${revMatchedList.join(" / ")}）。`;
    } else if (overlapsCreditedEvidence) {
      status = "pending";
      explanation = "该表达与已计入的迁移证据重复，请在不同语境下使用其他目标表达。";
    } else {
      status = "pending";
      explanation = "尚未在改写稿中观察到目标表达，建议按提示在相关段落尝试改写。";
    }

    return {
      targetId: target.id,
      category: target.category,
      criterion: target.criterion,
      label: target.label,
      status,
      baselineMatched: baseHit.matched,
      revisedMatched: revMatchedList,
      matchedParagraphIndices: revParagraphList,
      clicheHits: revCliche.matched,
      guidance: target.guidance,
      explanation,
    };
  });

  const transferredCount = items.filter((item) => item.status === "transferred").length;
  const regressedCount = items.filter((item) => item.status === "regressed").length;
  const memorizedClicheCount = items.filter(
    (item) => item.status === "memorized_cliche",
  ).length;
  const pendingCount = items.filter((item) => item.status === "pending").length;
  const totalTargets = items.length;
  const transferRate = totalTargets > 0 ? transferredCount / totalTargets : 0;

  let disqualificationReason: string | undefined;
  if (revisedWordCount === 0) {
    disqualificationReason = "请先提交至少一段写作正文，再复核改写。";
  } else if ((advancingLineage || freshPrompt) && !hasBaselineText) {
    disqualificationReason = "请先提交含英文正文的一稿，再复核跨草稿迁移。";
  } else if (!canEvaluateTransfer) {
    disqualificationReason = samePrompt
      ? "当前稿件与所选底稿的版本关系无法确认，暂不计作有效跨草稿迁移。"
      : "题目已更换，须完成独立新题迁移复核后才可计入正式掌握度。";
  } else if (totalTargets === 0) {
    disqualificationReason = "当前未配置目标迁移项，无法确认跨草稿迁移，暂作为练习诊断反馈。";
  } else if (topicRelevance.isOffTopic || topicRelevance.isTangential) {
    disqualificationReason = "当前内容未能实质性回应题干核心争议与政策维度，疑似偏题，仅作练习诊断反馈，不计入正式掌握度。";
  } else if (!hasSubstantiveRevision) {
    disqualificationReason = "修订稿相对初稿缺少实质性句法或内容改写，仅保留为练习诊断反馈，不计入正式掌握度。";
  } else if (hasLowEntropyStuffing) {
    disqualificationReason = "检测到低信息量重复填充文本，已降级为练习诊断反馈，不计入正式掌握度。";
  } else if (hasMechanicalKeywordPaste) {
    disqualificationReason = "检测到脱离完整论证句境的机械关键词拼贴，已降级为练习诊断反馈，不计入正式掌握度。";
  } else if (hasStuffing || memorizedClicheCount > 0) {
    disqualificationReason = "检测到模板套话堆砌，需替换为贴合语境的原创表达后才可计入量规复核证据。";
  } else if (regressedCount > 0) {
    disqualificationReason = "检测到部分维度相对一稿出现回退，需修复后再确认正式迁移。";
  }

  const minimumTransferred = Math.max(1, Math.ceil(totalTargets * 0.5));
  const meetsCrossDraftVerification =
    advancingLineage && !disqualificationReason && transferredCount >= minimumTransferred;

  const report: TransferAnalysis = {
    fromDraftId: input.draft1.draftId,
    toDraftId: input.draft2.draftId,
    sourceDraft: getWritingDraftSource(input.draft2),
    transferSource: getWritingTransferSource(input.draft1, input.targets),
    items,
    paragraphDiffs,
    memorizedTemplateHits,
    summary: {
      totalTargets,
      transferredCount,
      regressedCount,
      memorizedClicheCount,
      pendingCount,
      transferRate,
      hasMemorizedStuffing: hasStuffing,
      hasSubstantiveRevision,
      hasLowEntropyStuffing,
      hasMechanicalKeywordPaste,
      meetsCrossDraftVerification,
      disqualificationReason,
    },
  };
  return { report, creditedOccurrences, topicRelevance };
}

type ParagraphEvidence = {
  readonly paragraphIndex: number;
  readonly excerpt: string;
  readonly startOffset: number;
  readonly endOffset: number;
};

export type EvaluateRevisedDraftInput = {
  readonly baselineDraft: IeltsEssayDraft;
  readonly revisedDraft: IeltsEssayDraft;
  readonly targets: readonly IeltsUpgradeTarget[];
  readonly receiptId: string;
  readonly promptStatement?: string;
  readonly freshPromptTransfer?: boolean;
  readonly createdAt?: string;
};

export type EvaluateRevisedDraftResult = {
  readonly transferReport: IeltsCrossDraftTransferReport;
} & (
  | { readonly ok: true; readonly receipt: IeltsRubricReceipt }
  | { readonly ok: false; readonly reason: "empty_draft"; readonly receipt: null }
);

/** Evaluates a revision and issues a grounded rubric receipt when there is submitted text. */
export function evaluateRevisedDraftDeterministically(
  input: EvaluateRevisedDraftInput,
): EvaluateRevisedDraftResult {
  const freshPrompt = input.revisedDraft.promptId !== input.baselineDraft.promptId &&
    input.freshPromptTransfer === true;
  const paragraphs = input.revisedDraft.paragraphs;
  const revisedProse = maskIeltsParagraphs(paragraphs);
  const segmentedParagraphs = revisedProse.map(segmentIeltsText);
  const wordCount = countProseWords(revisedProse.join("\n"));
  const {
    report: transferReport,
    creditedOccurrences,
    topicRelevance,
  } = analyzeTransfer({
    draft1: input.baselineDraft,
    draft2: input.revisedDraft,
    targets: input.targets,
    promptStatement: input.promptStatement,
  }, freshPrompt, revisedProse, segmentedParagraphs, wordCount);

  if (wordCount === 0) {
    return {
      ok: false,
      reason: "empty_draft",
      receipt: null,
      transferReport: finalizeTransferReport(transferReport, false),
    };
  }

  const paragraphBoundaries = paragraphs.map(graphemeBoundaries);
  function evidenceSnippet(
    source: Pick<GroundedTextSpan, "startOffset" | "endOffset">,
    paragraphIndex: number,
    match?: MatchRange,
    citationBounds?: MatchRange,
  ): ParagraphEvidence | null {
    const prose = revisedProse[paragraphIndex]!;
    const boundaries = paragraphBoundaries[paragraphIndex]!;
    const limits = trimToProseGraphemes(
      prose, boundaries, citationBounds?.start ?? source.startOffset, citationBounds?.end ?? source.endOffset,
    );
    if (!limits) return null;
    const { startOffset: minStart, endOffset: maxEnd } = limits;
    const requiredStart = Math.max(minStart, boundaries.floor(match?.start ?? minStart));
    const requiredEnd = Math.min(maxEnd, boundaries.ceil(match?.end ?? minStart));
    const width = Math.min(maxEnd - minStart, Math.max(130, requiredEnd - requiredStart));
    const contextBefore = Math.floor((width - (requiredEnd - requiredStart)) / 2);
    const windowStart = Math.max(minStart, Math.min(requiredStart - contextBefore, maxEnd - width));
    let start = boundaries.ceil(windowStart);
    const windowEnd = Math.min(maxEnd, windowStart + width);
    let end = boundaries.floor(windowEnd);
    if (end <= start) end = boundaries.ceil(windowEnd);

    // Prefer word edges if they leave the matched occurrence intact.
    if (start > minStart && !/\s/u.test(prose[start - 1]!)) {
      const firstSpace = prose.indexOf(" ", start);
      if (firstSpace >= start && firstSpace < requiredStart) start = boundaries.ceil(firstSpace + 1);
    }
    if (end < maxEnd) {
      const lastSpace = prose.lastIndexOf(" ", end - 1);
      if (lastSpace > start + 40 && lastSpace >= requiredEnd) end = boundaries.floor(lastSpace);
    }
    const range = trimToProseGraphemes(prose, boundaries, start, end) ?? limits;
    return { paragraphIndex, ...range, excerpt: paragraphs[paragraphIndex]!.slice(range.startOffset, range.endOffset) };
  }

  const fallbackEvidence = segmentedParagraphs.flatMap((sentences, paragraphIndex) => {
    for (const sentence of sentences) {
      const snippet = evidenceSnippet(sentence, paragraphIndex);
      if (snippet) return [snippet];
    }
    return [];
  });

  const templateHits = transferReport.memorizedTemplateHits;
  const templatePenalty =
    templateHits.some((h) => h.severity === "blocking") || templateHits.length >= 2
      ? 1.0
      : templateHits.length > 0
        ? 0.5
        : 0;
  const stuffingPenalty =
    transferReport.summary.hasLowEntropyStuffing ||
    transferReport.summary.hasMechanicalKeywordPaste
      ? 1.0
      : 0;

  const { isOffTopic, isTangential } = topicRelevance;

  const criterionTransfers = (criterion: IeltsCriterion) =>
    transferReport.items.filter((item) => item.criterion === criterion);

  const scoreCriterion = (criterion: IeltsCriterion): IeltsBandScore => {
    const related = criterionTransfers(criterion);
    const transferred = related.filter((r) => r.status === "transferred").length;
    const regressed = related.filter((r) => r.status === "regressed").length;
    const cliches = related.filter((r) => r.status === "memorized_cliche").length;
    const lengthBonus =
      wordCount >= 240 && !transferReport.summary.hasLowEntropyStuffing && !isOffTopic && !isTangential
        ? 0.5
        : wordCount < 160
          ? -0.5
          : 0;
    const base =
      6.0 +
      lengthBonus +
      transferred * 0.5 -
      regressed * 0.5 -
      cliches * 0.5 -
      stuffingPenalty;
    const penalized =
      criterion === "LR" || criterion === "TR"
        ? base - templatePenalty
        : base - templatePenalty * 0.5;
    let capped = penalized;
    if (isOffTopic) {
      capped = Math.min(capped, criterion === "TR" ? 4.0 : 4.5);
    } else if (isTangential) {
      capped = Math.min(capped, 4.5);
    }
    return clampToIeltsBand(capped);
  };

  function findCriterionEvidence(
    criterion: IeltsCriterion,
    patterns: readonly string[],
    fallbackPosition: number,
  ): ParagraphEvidence {
    const occurrence = creditedOccurrences.get(criterion);
    if (occurrence) {
      const { sentence, paragraphIndex, start, end, citationBounds } = occurrence;
      const snippet = evidenceSnippet(sentence, paragraphIndex, { start, end }, citationBounds);
      if (snippet) return snippet;
    }
    for (const [paragraphIndex, sentences] of segmentedParagraphs.entries()) {
      for (const sentence of sentences) {
        for (const pattern of patterns) {
          const [match] = findPatternRanges(sentence.text, pattern);
          if (!match) continue;
          const snippet = evidenceSnippet(sentence, paragraphIndex, {
            start: sentence.startOffset + match.start,
            end: sentence.startOffset + match.end,
          });
          if (snippet) return snippet;
        }
      }
    }
    // A draft with counted words has at least one prose sentence with a citable range.
    return fallbackEvidence[Math.min(fallbackPosition, fallbackEvidence.length - 1)]!;
  }

  const trLoc = findCriterionEvidence(
    "TR",
    ["admittedly", "critics", "while", "counter", "public transit", "funding"],
    2,
  );
  const ccLoc = findCriterionEvidence(
    "CC",
    ["consequently", "by contrast", "moreover", "this shift", "such investment", "in turn"],
    1,
  );
  const diagnosedTemplate = templateHits[0];
  let templateEvidence: ParagraphEvidence | null = null;
  if (diagnosedTemplate) {
    const { paragraphIndex, startOffset, endOffset } = diagnosedTemplate;
    const source = segmentedParagraphs[paragraphIndex]!.find(
      (sentence) => sentence.startOffset <= startOffset && sentence.endOffset >= endOffset,
    ) ?? { startOffset: 0, endOffset: paragraphs[paragraphIndex]!.length };
    templateEvidence = evidenceSnippet(source, paragraphIndex, { start: startOffset, end: endOffset });
  }
  const lrLoc = templateEvidence ??
    findCriterionEvidence("LR", ["alleviate", "viability", "emissions", "congestion", "infrastructure"], 0);
  const graLoc = findCriterionEvidence(
    "GRA",
    ["while", "although", "whereas", "which", "whereby", "rather than"],
    1,
  );

  const trBand = scoreCriterion("TR");
  const ccBand = scoreCriterion("CC");
  const lrBand = scoreCriterion("LR");
  const graBand = scoreCriterion("GRA");

  const trSpan: IeltsSpanEvidence = {
    id: `${input.receiptId}-tr-1`,
    ...trLoc,
    criterion: "TR",
    diagnosis:
      isOffTopic
        ? "当前作答未覆盖题干核心主题词，疑似偏题；任务回应与综合估分已按偏题规则封顶，请紧扣题干争议重写作答。"
        : isTangential
          ? "当前作答与题干主题词汇重合度极低，疑似跑题或泛谈，任务回应分数已受限。"
          : creditedOccurrences.has("TR")
            ? "核心立场与反方权衡已落地，论证不再停留在单边泛谈。"
            : "该段论证可进一步回应反方前提（如短期道路扩容的边际效益递减），增强立场深度。",
    upgradeRewrite:
      "Admittedly, widening arterial roads may ease bottlenecks temporarily, yet induced traffic demand typically erodes those gains within a few years.",
  };

  const ccSpan: IeltsSpanEvidence = {
    id: `${input.receiptId}-cc-1`,
    ...ccLoc,
    criterion: "CC",
    diagnosis:
      creditedOccurrences.has("CC")
        ? "段内因果与对照指代衔接自然，推进节奏清晰。"
        : "句间逻辑过渡偏依赖平铺连接，可用指代回指（this shift / consequently）收紧段落主线。",
    upgradeRewrite:
      "Consequently, shifting capital expenditure toward high-capacity rail directly lowers commuter reliance on private vehicles.",
  };

  const lrSpan: IeltsSpanEvidence = {
    id: `${input.receiptId}-lr-1`,
    ...lrLoc,
    criterion: "LR",
    diagnosis:
      diagnosedTemplate
        ? `检测到高频模板表达（${diagnosedTemplate.phrase}），拉低词汇原创度与语域自然度。`
        : creditedOccurrences.has("LR")
          ? "已有效迁移精准学术搭配，用词具体且语域得体。"
          : "建议将笼统形容词替换为具体城市交通学术搭配（如 alleviate chronic congestion / per-capita emissions）。",
    upgradeRewrite:
      "Prioritising high-capacity urban rail helps alleviate chronic congestion while curbing per-capita emissions across expanding metropolitan areas.",
  };

  const graSpan: IeltsSpanEvidence = {
    id: `${input.receiptId}-gra-1`,
    ...graLoc,
    criterion: "GRA",
    diagnosis:
      creditedOccurrences.has("GRA")
        ? "让步从句与非限定修饰结构运用准确，句式层次更丰富。"
        : "简单句与并列句偏多，建议加入 While/Although 让步结构或非限定定语从句提升句法控制。",
    upgradeRewrite:
      "While expanding motorways offers immediate relief for suburban drivers, it rarely resolves core urban gridlock over the long term.",
  };

  const assessments: IeltsCriterionAssessment[] = [
    {
      criterion: "TR",
      band: trBand,
      summary:
        isOffTopic
          ? "内容偏离题干核心主题（与题干关键词零重合），任务回应与综合估分已按偏题封顶。"
          : isTangential
            ? "论证与题干核心主题关联薄弱，任务回应分数已受限。"
            : trBand >= 7
              ? "立场一贯且兼顾反方权衡，任务回应充分。"
              : "立场明确，但反方回应与例证展开仍有提升空间。",
      evidenceSpans: [trSpan],
    },
    {
      criterion: "CC",
      band: ccBand,
      summary:
        ccBand >= 7
          ? "段落中心突出，逻辑指代自然流畅。"
          : "段落结构清楚，可通过更精准的因果与对照指代减少生硬衔接。",
      evidenceSpans: [ccSpan],
    },
    {
      criterion: "LR",
      band: lrBand,
      summary:
        templateHits.length > 0
          ? "存在模板套话，需替换为具体贴题的学术搭配。"
          : lrBand >= 7
            ? "学术搭配自然准确，有效避免了低效重复。"
            : "词汇基本达意，可进一步用精准搭配替换泛化表达。",
      evidenceSpans: [lrSpan],
    },
    {
      criterion: "GRA",
      band: graBand,
      summary:
        graBand >= 7
          ? "复合句与让步结构控制稳健，标点准确。"
          : "基础句法准确，建议增加让步与因果复合结构丰富节奏。",
      evidenceSpans: [graSpan],
    },
  ];

  const canQualifyFreshPrompt =
    freshPrompt &&
    !transferReport.summary.disqualificationReason &&
    transferReport.summary.transferredCount >=
      Math.max(1, Math.ceil(transferReport.summary.totalTargets * 0.5));

  const validated = createValidatedRubricReceipt({
    receiptId: input.receiptId,
    taskMode: "writing_task2",
    draft: input.revisedDraft,
    baselineDraft: input.baselineDraft,
    transferTargets: input.targets,
    assessments,
    crossDraftTransferVerified: transferReport.summary.meetsCrossDraftVerification,
    freshPromptTransfer: canQualifyFreshPrompt,
    disqualificationReason: transferReport.summary.disqualificationReason,
    createdAt: input.createdAt,
  });

  if (!validated.ok) {
    throw new Error(
      `Internal error: deterministic IELTS receipt failed validation: ${validated.errors.map((e) => e.message).join("; ")}`,
    );
  }

  return {
    ok: true,
    transferReport: finalizeTransferReport(transferReport, validated.receipt.masteryQualified),
    receipt: validated.receipt,
  };
}
