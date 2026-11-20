import {
  clampToIeltsBand,
  countDraftWords,
  countEnglishWords,
  createValidatedRubricReceipt,
  detectMemorizedTemplates,
  hasMemorizedTemplateStuffing,
} from "./rubric";
import type {
  IeltsBandScore,
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

function tokenizeWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []);
}

function splitSentences(paragraph: string): string[] {
  const parts = paragraph
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : paragraph.trim() ? [paragraph.trim()] : [];
}

/**
 * Splits text into elementary clauses along sentence boundaries, colons,
 * semicolons, em/en dashes, double hyphens, spaced hyphens, and parentheticals
 * (preserving intra-word hyphens like "per-capita" or "long-term").
 * Ensures appended noun lists after ":", ";", "—", "--", or "(...)" are
 * isolated from the preceding clause rather than borrowing its verb or
 * distorting its similarity score.
 */
export function splitElementaryClauses(text: string): string[] {
  const normalizedParentheticals = text
    .replace(/\(([^()]*)\)/gu, "; $1 ;")
    .replace(/\[([^[\]]*)\]/gu, "; $1 ;");

  return normalizedParentheticals
    .split(/(?:[.!?]+|[;:\n]+|[\u2014\u2013]+|--+|\s+-\s+)/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function matchesPattern(text: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  const parts = trimmed.split(/\s+/).map(escapeRegExp);
  const regex = new RegExp(`(?<![\\p{L}\\p{N}])${parts.join("\\s+")}(?![\\p{L}\\p{N}])`, "iu");
  return regex.test(text);
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
export function detectLowEntropyStuffing(paragraphs: readonly string[]): boolean {
  const fullText = paragraphs.join(" ");
  const allWords = tokenizeWords(fullText);
  if (allWords.length >= 60) {
    const overallTtr = new Set(allWords).size / allWords.length;
    if (overallTtr < 0.36) return true;
  }

  // Repeated 3-gram stuffing across essay or inside any paragraph.
  const globalTrigrams = new Map<string, number>();
  const seenSentences = new Map<string, number>();

  for (const paragraph of paragraphs) {
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

    for (const sentence of splitSentences(paragraph)) {
      const sWords = tokenizeWords(sentence);
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
  sentence: string,
  allTargetPatterns: readonly string[],
): boolean {
  const words = tokenizeWords(sentence);
  if (words.length < 7) return true;
  if (!CLAUSE_VERB_CUE.test(sentence)) return true;
  if (isLowEntropySentence(sentence)) return true;

  // Measure how many words of this sentence are just concatenated target expressions.
  const matchedPatterns = allTargetPatterns.filter((pattern) =>
    matchesPattern(sentence, pattern),
  );
  if (matchedPatterns.length === 0) return false;

  const matchedWordCount = matchedPatterns.reduce(
    (sum, pattern) => sum + tokenizeWords(pattern).length,
    0,
  );
  const nonTargetWords = Math.max(0, words.length - matchedWordCount);

  if (matchedPatterns.length >= 3 && matchedWordCount / words.length >= 0.45) {
    return true;
  }
  if (matchedPatterns.length >= 2 && nonTargetWords <= 4) {
    return true;
  }
  return false;
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

function isSubstantiveElementaryClause(clause: string): boolean {
  const words = tokenizeWords(clause);
  return (
    words.length >= 7 &&
    CLAUSE_VERB_CUE.test(clause) &&
    !isLowEntropySentence(clause)
  );
}

/**
 * Checks whether an elementary clause is substantively changed from every
 * baseline elementary clause. Blocks verbatim copies, punctuation-only swaps,
 * and baseline clauses with appended/prepended noun lists (whether colon-,
 * semicolon-, dash-, parenthetical-, or comma-attached).
 */
function isClauseSubstantivelyChangedFromBaseline(
  clause: string,
  baselineClauseKeys: ReadonlySet<string>,
  baselineClauseTokens: readonly (readonly string[])[],
): boolean {
  const key = normalizeSentenceTokenKey(clause);
  if (!key || baselineClauseKeys.has(key)) {
    return false;
  }
  const words = tokenizeWords(clause);
  const wordSet = new Set(words);

  for (const baseWords of baselineClauseTokens) {
    if (baseWords.length === 0) continue;
    if (tokenJaccardSimilarity(words, baseWords) >= 0.80) {
      return false;
    }

    // If nearly the entire baseline clause appears verbatim inside this clause
    // (e.g. copied baseline clause + appended noun tail), reject as unchanged.
    if (baseWords.length >= 6) {
      let containedCount = 0;
      for (const bw of baseWords) {
        if (wordSet.has(bw)) containedCount += 1;
      }
      const containment = containedCount / baseWords.length;
      const minRun = Math.min(6, Math.ceil(baseWords.length * 0.6));
      if (containment >= 0.85 && longestContiguousCommonRun(words, baseWords) >= minRun) {
        return false;
      }
    }
  }
  return true;
}

function extractPatternLocalWindows(
  clauseTokens: readonly string[],
  patternTokens: readonly string[],
  radius = 4,
): string[][] {
  if (patternTokens.length === 0 || clauseTokens.length < patternTokens.length) {
    return [];
  }
  const windows: string[][] = [];
  for (let i = 0; i <= clauseTokens.length - patternTokens.length; i += 1) {
    let matched = true;
    for (let k = 0; k < patternTokens.length; k += 1) {
      if (clauseTokens[i + k] !== patternTokens[k]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const left = clauseTokens.slice(Math.max(0, i - radius), i);
    const right = clauseTokens.slice(
      i + patternTokens.length,
      Math.min(clauseTokens.length, i + patternTokens.length + radius),
    );
    windows.push([...left, ...right]);
  }
  return windows;
}

/**
 * Checks whether EVERY occurrence of `pattern` in `clause` sits inside the same
 * local `[phrase - 4 words, phrase + 4 words]` lexical neighborhood as an
 * occurrence of `pattern` in the baseline draft's elementary clauses.
 */
function isPatternLocalContextCopiedFromBaseline(
  clause: string,
  pattern: string,
  baselineClauseTokens: readonly (readonly string[])[],
): boolean {
  const patternTokens = tokenizeWords(pattern);
  const candTokens = tokenizeWords(clause);
  const candWindows = extractPatternLocalWindows(candTokens, patternTokens, 4);
  if (candWindows.length === 0) return false;

  const baseWindows: string[][] = [];
  for (const baseTokens of baselineClauseTokens) {
    baseWindows.push(...extractPatternLocalWindows(baseTokens, patternTokens, 4));
  }
  if (baseWindows.length === 0) return false;

  return candWindows.every((cw) =>
    baseWindows.some((bw) => {
      if (tokenJaccardSimilarity(cw, bw) >= 0.75) return true;
      if (cw.length >= 3 && longestContiguousCommonRun(cw, bw) >= Math.min(4, cw.length)) {
        return true;
      }
      return false;
    }),
  );
}

function assessSubstantiveRevision(
  draft1: IeltsEssayDraft,
  draft2: IeltsEssayDraft,
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

  const baselineClauses = draft1.paragraphs.flatMap(splitElementaryClauses);
  const baselineClauseKeys = new Set(
    baselineClauses.map(normalizeSentenceTokenKey).filter(Boolean),
  );
  const baselineClauseTokens = baselineClauses.map(tokenizeWords);

  const revisedClauses = draft2.paragraphs.flatMap(splitElementaryClauses);
  const rewrittenSubstantiveClauses = revisedClauses.filter(
    (c) =>
      isSubstantiveElementaryClause(c) &&
      isClauseSubstantivelyChangedFromBaseline(
        c,
        baselineClauseKeys,
        baselineClauseTokens,
      ),
  );
  const rewrittenRatio =
    revisedClauses.length > 0
      ? rewrittenSubstantiveClauses.length / revisedClauses.length
      : 0;

  // Only count new vocabulary that lives inside genuinely rewritten grammatical clauses
  // (never appended colon/semicolon/dash/comma bare noun lists).
  const terms1 = extractMeaningfulTerms(draft1.paragraphs.join(" "));
  const substantiveRevisedText = rewrittenSubstantiveClauses.join(" ");
  const substantiveTerms2 = extractMeaningfulTerms(substantiveRevisedText);
  const newlyAddedSubstantiveTerms = [...substantiveTerms2].filter(
    (t) => !terms1.has(t),
  );

  const allClauseTerms2 = extractMeaningfulTerms(
    revisedClauses.filter(isSubstantiveElementaryClause).join(" "),
  );
  const removedTerms = [...terms1].filter((t) => !allClauseTerms2.has(t));
  const unionSize = new Set([...terms1, ...allClauseTerms2]).size;
  const jaccardDistance =
    unionSize > 0
      ? (newlyAddedSubstantiveTerms.length + removedTerms.length) / unionSize
      : 0;

  return (
    rewrittenSubstantiveClauses.length >= 2 &&
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

    const terms1 = extractMeaningfulTerms(p1);
    const terms2 = extractMeaningfulTerms(p2);
    const addedTerms = [...terms2].filter((t) => !terms1.has(t)).slice(0, 8);
    const removedTerms = [...terms1].filter((t) => !terms2.has(t)).slice(0, 8);

    diffs.push({
      paragraphIndex: i,
      draft1Text: p1,
      draft2Text: p2,
      status,
      wordDelta: countEnglishWords(p2) - countEnglishWords(p1),
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
};

/**
 * Deterministic cross-draft analyzer comparing Draft 1 -> Draft 2+ across
 * collocations, syntactic structures, cohesive devices, and counterargument depth.
 * Guards against empty targets, unchanged/punctuation-only resubmissions, low-entropy
 * filler stuffing, and mechanical keyword-list pasting.
 */
export function analyzeCrossDraftTransfer(
  input: AnalyzeCrossDraftTransferInput,
): IeltsCrossDraftTransferReport {
  const paragraphDiffs = diffEssayParagraphs(
    input.draft1.paragraphs,
    input.draft2.paragraphs,
  );
  const memorizedTemplateHits = detectMemorizedTemplates(input.draft2.paragraphs);
  const hasStuffing = hasMemorizedTemplateStuffing(memorizedTemplateHits);
  const hasLowEntropyStuffing = detectLowEntropyStuffing(input.draft2.paragraphs);
  const hasSubstantiveRevision = assessSubstantiveRevision(
    input.draft1,
    input.draft2,
  );

  const baselineClauses = input.draft1.paragraphs.flatMap(splitElementaryClauses);
  const baselineClauseKeys = new Set(
    baselineClauses.map(normalizeSentenceTokenKey).filter(Boolean),
  );
  const baselineClauseTokens = baselineClauses.map(tokenizeWords);

  const allTargetPatterns = input.targets.flatMap((t) => t.targetPatterns);
  let hasMechanicalKeywordPaste = false;

  const items: IeltsUpgradeTransferItem[] = input.targets.map((target) => {
    const baseHit = findMatchedPatterns(input.draft1.paragraphs, target.targetPatterns);
    const rawRevHit = findMatchedPatterns(input.draft2.paragraphs, target.targetPatterns);
    const baseWeak = findMatchedPatterns(
      input.draft1.paragraphs,
      target.weakBaselinePatterns,
    );
    const revWeak = findMatchedPatterns(
      input.draft2.paragraphs,
      target.weakBaselinePatterns,
    );
    const revCliche = findMatchedPatterns(
      input.draft2.paragraphs,
      target.clichePatterns,
    );

    // Verify each revised match appears in a real, non-filler, substantively revised elementary clause
    // whose local [phrase - 4 words, phrase + 4 words] context was not copied verbatim from Draft 1.
    const contextualMatched = new Set<string>();
    const contextualParagraphs = new Set<number>();
    let matchedOnlyInMechanicalPaste = false;
    let matchedOnlyInUnchangedSentence = false;

    if (rawRevHit.matched.length > 0) {
      let sawMechanical = false;
      let sawUnchanged = false;

      input.draft2.paragraphs.forEach((paragraph, paragraphIndex) => {
        const clauses = splitElementaryClauses(paragraph);
        for (const pattern of target.targetPatterns) {
          for (const clause of clauses) {
            if (!matchesPattern(clause, pattern)) continue;
            if (isMechanicalKeywordSentence(clause, allTargetPatterns)) {
              hasMechanicalKeywordPaste = true;
              sawMechanical = true;
              continue;
            }
            if (
              !isClauseSubstantivelyChangedFromBaseline(
                clause,
                baselineClauseKeys,
                baselineClauseTokens,
              ) ||
              isPatternLocalContextCopiedFromBaseline(
                clause,
                pattern,
                baselineClauseTokens,
              )
            ) {
              sawUnchanged = true;
              continue;
            }
            contextualMatched.add(pattern);
            contextualParagraphs.add(paragraphIndex);
          }
        }
      });

      if (contextualMatched.size === 0) {
        if (sawMechanical) matchedOnlyInMechanicalPaste = true;
        else if (sawUnchanged) matchedOnlyInUnchangedSentence = true;
      }
    }

    const revMatchedList = [...contextualMatched];
    const revParagraphList = [...contextualParagraphs].sort((a, b) => a - b);

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
    } else if (matchedOnlyInMechanicalPaste) {
      status = "pending";
      explanation = `仅检测到目标词组的机械拼贴或重复填充句（${rawRevHit.matched.join(" / ")}），需融入完整论证语境后再复核。`;
    } else if (matchedOnlyInUnchangedSentence || (revMatchedList.length > 0 && !hasSubstantiveRevision)) {
      status = "pending";
      explanation = `目标表达所在句子相对一稿未作实质性改写（或仅调整标点），暂不计作有效跨草稿迁移。`;
    } else if (revMatchedList.length > 0) {
      status = "transferred";
      const clearedWeak =
        baseWeak.matched.length > 0 && revWeak.matched.length < baseWeak.matched.length;
      explanation = clearedWeak
        ? `已成功替换为目标表达（${revMatchedList.join(" / ")}），并清除了原稿薄弱说法。`
        : `已在第 ${revParagraphList.map((idx) => idx + 1).join("、")} 段自然运用目标表达（${revMatchedList.join(" / ")}）。`;
    } else {
      status = "pending";
      explanation = `尚未在改写稿中观察到目标表达，建议按提示在相关段落尝试改写。`;
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
  if (totalTargets === 0) {
    disqualificationReason = "当前未配置目标迁移项，无法确认跨草稿迁移，暂作为练习诊断反馈。";
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
    totalTargets > 0 &&
    hasSubstantiveRevision &&
    !hasLowEntropyStuffing &&
    !hasMechanicalKeywordPaste &&
    !hasStuffing &&
    regressedCount === 0 &&
    memorizedClicheCount === 0 &&
    transferredCount >= minimumTransferred;

  return {
    fromDraftId: input.draft1.draftId,
    toDraftId: input.draft2.draftId,
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
      masteryQualified: meetsCrossDraftVerification,
      disqualificationReason,
    },
  };
}

function firstSentenceSnippet(paragraph: string, maxChars = 130): string {
  const trimmed = paragraph.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^[^.!?]+[.!?]?/);
  const sentence = (match ? match[0] : trimmed).trim();
  if (sentence.length <= maxChars) return sentence;
  const sliced = sentence.slice(0, maxChars);
  const lastSpace = sliced.lastIndexOf(" ");
  return (lastSpace > 40 ? sliced.slice(0, lastSpace) : sliced).trim();
}

function findParagraphMatching(
  paragraphs: readonly string[],
  patterns: readonly string[],
  fallbackIndex: number,
): { paragraphIndex: number; excerpt: string } {
  for (let i = 0; i < paragraphs.length; i += 1) {
    const p = paragraphs[i] ?? "";
    for (const pattern of patterns) {
      if (matchesPattern(p, pattern)) {
        const snippet = firstSentenceSnippet(p);
        if (snippet) return { paragraphIndex: i, excerpt: snippet };
      }
    }
  }
  const safeIndex = Math.min(Math.max(0, fallbackIndex), Math.max(0, paragraphs.length - 1));
  return {
    paragraphIndex: safeIndex,
    excerpt: firstSentenceSnippet(paragraphs[safeIndex] ?? "") || (paragraphs[safeIndex] ?? "").trim(),
  };
}

export type EvaluateRevisedDraftInput = {
  readonly baselineDraft: IeltsEssayDraft;
  readonly revisedDraft: IeltsEssayDraft;
  readonly targets: readonly IeltsUpgradeTarget[];
  readonly receiptId: string;
  readonly freshPromptTransfer?: boolean;
  readonly createdAt?: string;
};

/**
 * Deterministic live evaluator used when a learner edits Draft 2 in the workbench.
 * Always produces a validated, span-grounded 4-dimension receipt + transfer report.
 */
export function evaluateRevisedDraftDeterministically(
  input: EvaluateRevisedDraftInput,
): {
  readonly transferReport: IeltsCrossDraftTransferReport;
  readonly receipt: IeltsRubricReceipt;
} {
  const transferReport = analyzeCrossDraftTransfer({
    draft1: input.baselineDraft,
    draft2: input.revisedDraft,
    targets: input.targets,
  });

  const nonEmptyParagraphs = input.revisedDraft.paragraphs.map((p) => p.trim()).filter(Boolean);
  const paragraphs = nonEmptyParagraphs.length > 0 ? nonEmptyParagraphs : ["(Empty draft)"];
  const wordCount = countDraftWords(paragraphs);
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

  const criterionTransfers = (criterion: "TR" | "CC" | "LR" | "GRA") =>
    transferReport.items.filter((item) => item.criterion === criterion);

  const scoreCriterion = (criterion: "TR" | "CC" | "LR" | "GRA"): IeltsBandScore => {
    const related = criterionTransfers(criterion);
    const transferred = related.filter((r) => r.status === "transferred").length;
    const regressed = related.filter((r) => r.status === "regressed").length;
    const cliches = related.filter((r) => r.status === "memorized_cliche").length;
    const lengthBonus =
      wordCount >= 240 && !transferReport.summary.hasLowEntropyStuffing
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
    return clampToIeltsBand(penalized);
  };

  const trLoc = findParagraphMatching(
    paragraphs,
    ["admittedly", "critics", "while", "counter", "public transit", "funding"],
    Math.min(2, paragraphs.length - 1),
  );
  const ccLoc = findParagraphMatching(
    paragraphs,
    ["consequently", "by contrast", "moreover", "this shift", "such investment", "in turn"],
    Math.min(1, paragraphs.length - 1),
  );
  const lrLoc = findParagraphMatching(
    paragraphs,
    templateHits.length > 0
      ? templateHits.map((h) => h.phrase)
      : ["alleviate", "viability", "emissions", "congestion", "infrastructure"],
    0,
  );
  const graLoc = findParagraphMatching(
    paragraphs,
    ["while", "although", "whereas", "which", "whereby", "rather than"],
    Math.min(1, paragraphs.length - 1),
  );

  const trBand = scoreCriterion("TR");
  const ccBand = scoreCriterion("CC");
  const lrBand = scoreCriterion("LR");
  const graBand = scoreCriterion("GRA");

  const trSpan: IeltsSpanEvidence = {
    id: `${input.receiptId}-tr-1`,
    paragraphIndex: trLoc.paragraphIndex,
    excerpt: trLoc.excerpt,
    criterion: "TR",
    diagnosis:
      criterionTransfers("TR").some((i) => i.status === "transferred")
        ? "核心立场与反方权衡已落地，论证不再停留在单边泛谈。"
        : "该段论证可进一步回应反方前提（如短期道路扩容的边际效益递减），增强立场深度。",
    upgradeRewrite:
      "Admittedly, widening arterial roads may ease bottlenecks temporarily, yet induced traffic demand typically erodes those gains within a few years.",
  };

  const ccSpan: IeltsSpanEvidence = {
    id: `${input.receiptId}-cc-1`,
    paragraphIndex: ccLoc.paragraphIndex,
    excerpt: ccLoc.excerpt,
    criterion: "CC",
    diagnosis:
      criterionTransfers("CC").some((i) => i.status === "transferred")
        ? "段内因果与对照指代衔接自然，推进节奏清晰。"
        : "句间逻辑过渡偏依赖平铺连接，可用指代回指（this shift / consequently）收紧段落主线。",
    upgradeRewrite:
      "Consequently, shifting capital expenditure toward high-capacity rail directly lowers commuter reliance on private vehicles.",
  };

  const lrSpan: IeltsSpanEvidence = {
    id: `${input.receiptId}-lr-1`,
    paragraphIndex: lrLoc.paragraphIndex,
    excerpt: lrLoc.excerpt,
    criterion: "LR",
    diagnosis:
      templateHits.length > 0
        ? `检测到高频模板表达（${templateHits[0]?.phrase}），拉低词汇原创度与语域自然度。`
        : criterionTransfers("LR").some((i) => i.status === "transferred")
          ? "已有效迁移精准学术搭配，用词具体且语域得体。"
          : "建议将笼统形容词替换为具体城市交通学术搭配（如 alleviate chronic congestion / per-capita emissions）。",
    upgradeRewrite:
      "Prioritising high-capacity urban rail helps alleviate chronic congestion while curbing per-capita emissions across expanding metropolitan areas.",
  };

  const graSpan: IeltsSpanEvidence = {
    id: `${input.receiptId}-gra-1`,
    paragraphIndex: graLoc.paragraphIndex,
    excerpt: graLoc.excerpt,
    criterion: "GRA",
    diagnosis:
      criterionTransfers("GRA").some((i) => i.status === "transferred")
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
        trBand >= 7
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

  // Guard freshPromptTransfer too against empty targets or low-entropy / mechanical stuffing.
  const canQualifyFreshPrompt =
    Boolean(input.freshPromptTransfer) &&
    transferReport.summary.totalTargets > 0 &&
    !transferReport.summary.hasLowEntropyStuffing &&
    !transferReport.summary.hasMechanicalKeywordPaste &&
    transferReport.summary.transferredCount >=
      Math.max(1, Math.ceil(transferReport.summary.totalTargets * 0.5));

  const validated = createValidatedRubricReceipt({
    receiptId: input.receiptId,
    taskMode: "writing_task2",
    draft: { ...input.revisedDraft, paragraphs },
    assessments,
    crossDraftTransferVerified: transferReport.summary.meetsCrossDraftVerification,
    freshPromptTransfer: canQualifyFreshPrompt,
    disqualificationReason:
      input.revisedDraft.version >= 2
        ? transferReport.summary.disqualificationReason
        : undefined,
    createdAt: input.createdAt,
  });

  if (!validated.ok) {
    throw new Error(
      `Internal error: deterministic IELTS receipt failed validation: ${validated.errors.map((e) => e.message).join("; ")}`,
    );
  }

  return {
    transferReport,
    receipt: validated.receipt,
  };
}
