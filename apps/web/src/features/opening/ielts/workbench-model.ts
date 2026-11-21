import {
  IELTS_CRITERION_META,
  graphemeBoundaries,
  locateGroundedExcerpt,
  maskIeltsMarkup,
  type IeltsBandScore,
  type IeltsCriterion,
  type IeltsEpistemicStatus,
  type IeltsSpanEvidence,
  type IeltsSpeakingPaceStatus,
  type IeltsSpeakingSignalKey,
  type IeltsSpeakingSignalRating,
  type IeltsTransferStatus,
  type IeltsUpgradeCategory,
} from "./domain-bridge";

export type DraftViewMode = "draft1" | "draft2" | "compare";

export type CriterionVisualStyle = {
  readonly code: IeltsCriterion;
  readonly zhLabel: string;
  readonly officialName: string;
  readonly chipClass: string;
  readonly activeChipClass: string;
  readonly markClass: string;
  readonly activeMarkClass: string;
  readonly badgeClass: string;
  readonly accentBarClass: string;
};

/**
 * Semantic object tokens from tailwind.css (obj-1..obj-4) guarantee tuned light/dark
 * contrast without any fixed Tailwind palette classes.
 */
export const CRITERION_STYLES: Readonly<Record<IeltsCriterion, CriterionVisualStyle>> = {
  TR: {
    code: "TR",
    zhLabel: IELTS_CRITERION_META.TR.zhLabel,
    officialName: IELTS_CRITERION_META.TR.officialName,
    chipClass: "border-line bg-surface text-text-2 hover:border-obj-1/40 hover:text-text",
    activeChipClass: "border-obj-1/45 bg-obj-1/12 text-obj-1 font-medium",
    markClass: "bg-obj-1/12 text-text border-b-2 border-obj-1/50 hover:bg-obj-1/20",
    activeMarkClass: "bg-obj-1/24 text-text border-b-2 border-obj-1 ring-2 ring-obj-1/35",
    badgeClass: "border-obj-1/30 bg-obj-1/12 text-obj-1",
    accentBarClass: "bg-obj-1",
  },
  CC: {
    code: "CC",
    zhLabel: IELTS_CRITERION_META.CC.zhLabel,
    officialName: IELTS_CRITERION_META.CC.officialName,
    chipClass: "border-line bg-surface text-text-2 hover:border-obj-2/40 hover:text-text",
    activeChipClass: "border-obj-2/45 bg-obj-2/12 text-text font-medium",
    markClass: "bg-obj-2/12 text-text border-b-2 border-obj-2/50 hover:bg-obj-2/20",
    activeMarkClass: "bg-obj-2/24 text-text border-b-2 border-obj-2 ring-2 ring-obj-2/35",
    badgeClass: "border-obj-2/30 bg-obj-2/12 text-obj-2",
    accentBarClass: "bg-obj-2",
  },
  LR: {
    code: "LR",
    zhLabel: IELTS_CRITERION_META.LR.zhLabel,
    officialName: IELTS_CRITERION_META.LR.officialName,
    chipClass: "border-line bg-surface text-text-2 hover:border-obj-3/40 hover:text-text",
    activeChipClass: "border-obj-3/45 bg-obj-3/12 text-obj-3 font-medium",
    markClass: "bg-obj-3/12 text-text border-b-2 border-obj-3/50 hover:bg-obj-3/20",
    activeMarkClass: "bg-obj-3/24 text-text border-b-2 border-obj-3 ring-2 ring-obj-3/35",
    badgeClass: "border-obj-3/30 bg-obj-3/12 text-obj-3",
    accentBarClass: "bg-obj-3",
  },
  GRA: {
    code: "GRA",
    zhLabel: IELTS_CRITERION_META.GRA.zhLabel,
    officialName: IELTS_CRITERION_META.GRA.officialName,
    chipClass: "border-line bg-surface text-text-2 hover:border-obj-4/40 hover:text-text",
    activeChipClass: "border-obj-4/45 bg-obj-4/12 text-obj-4 font-medium",
    markClass: "bg-obj-4/12 text-text border-b-2 border-obj-4/50 hover:bg-obj-4/20",
    activeMarkClass: "bg-obj-4/24 text-text border-b-2 border-obj-4 ring-2 ring-obj-4/35",
    badgeClass: "border-obj-4/30 bg-obj-4/12 text-obj-4",
    accentBarClass: "bg-obj-4",
  },
};

export const UPGRADE_CATEGORY_LABELS: Readonly<Record<IeltsUpgradeCategory, string>> = {
  targetCollocations: "核心搭配",
  syntacticStructures: "句式结构",
  cohesiveDevices: "衔接手段",
  counterargumentDepth: "反方论证深度",
};

export const TRANSFER_STATUS_META: Readonly<
  Record<IeltsTransferStatus, { readonly label: string; readonly badgeClass: string }>
> = {
  transferred: {
    label: "已迁移",
    badgeClass: "border-accent/30 bg-accent-soft text-accent",
  },
  pending: {
    label: "待改写",
    badgeClass: "border-line-strong bg-surface-2 text-text-2",
  },
  regressed: {
    label: "有回退",
    badgeClass: "border-warn/30 bg-warn-soft text-warn",
  },
  memorized_cliche: {
    label: "模板套话",
    badgeClass: "border-danger/30 bg-danger-soft text-danger",
  },
};

export const EPISTEMIC_BADGE_META: Readonly<
  Record<
    IeltsEpistemicStatus,
    {
      readonly writingLabel: string;
      readonly speakingLabel: string;
      readonly shortTag: string;
      readonly badgeClass: string;
      readonly dotClass: string;
    }
  >
> = {
  practice_feedback: {
    writingLabel: "练习诊断反馈 · 不计入正式掌握度",
    speakingLabel: "转写练习反馈 · 不计入正式掌握度",
    shortTag: "练习诊断",
    badgeClass: "border-warn/35 bg-warn-soft text-warn",
    dotClass: "bg-warn",
  },
  rubric_verified_evidence: {
    writingLabel: "量规复核证据 · 跨稿迁移已确认",
    speakingLabel: "口语转写迁移已确认 · 不含语音发音评分",
    shortTag: "量规复核",
    badgeClass: "border-accent/35 bg-accent-soft text-accent",
    dotClass: "bg-accent",
  },
};

export const SPEAKING_PACE_META: Readonly<
  Record<IeltsSpeakingPaceStatus, { readonly label: string; readonly badgeClass: string }>
> = {
  invalid_duration: {
    label: "时长无效",
    badgeClass: "border-danger/30 bg-danger-soft text-danger",
  },
  too_short: {
    label: "时长偏短",
    badgeClass: "border-warn/30 bg-warn-soft text-warn",
  },
  on_target: {
    label: "时长适中",
    badgeClass: "border-accent/30 bg-accent-soft text-accent",
  },
  over_time: {
    label: "作答超时",
    badgeClass: "border-warn/30 bg-warn-soft text-warn",
  },
};

export const SPEAKING_SIGNAL_ORDER: readonly IeltsSpeakingSignalKey[] = [
  "fluencyCohesion",
  "lexicalTransfer",
  "syntacticVariety",
  "durationCompliance",
];

export const SPEAKING_SIGNAL_RATING_META: Readonly<
  Record<IeltsSpeakingSignalRating, { readonly label: string; readonly badgeClass: string }>
> = {
  strong: {
    label: "表现扎实",
    badgeClass: "border-accent/30 bg-accent-soft text-accent",
  },
  developing: {
    label: "逐步成形",
    badgeClass: "border-line-strong bg-surface-2 text-text-2",
  },
  needs_work: {
    label: "仍需打磨",
    badgeClass: "border-warn/30 bg-warn-soft text-warn",
  },
};

export function formatBandScore(band: IeltsBandScore): string {
  return band.toFixed(1);
}

export function formatTimeBox(spentSeconds: number, boxSeconds: number): string {
  const spentMin = Math.max(1, Math.round(spentSeconds / 60));
  const boxMin = Math.max(1, Math.round(boxSeconds / 60));
  return `${spentMin} / ${boxMin} 分钟`;
}

const INVISIBLE_AND_COMBINING_CHARS =
  /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Mn}\p{Me}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u200B-\u200D\u2060\uFEFF]+/gu;

/**
 * Normalizes Writing/Speaking text into a canonical lexical key for sticky
 * assistance tracking. Strips all Unicode Default_Ignorable, Format, Combining,
 * and Variation Selector characters AFTER NFKC normalization and BEFORE lexical
 * token extraction so invisible characters can never split tokens.
 */
export function normalizeAssistedTextKey(text: string): string {
  const masked = maskIeltsMarkup(text)
    .normalize("NFKC")
    .normalize("NFD")
    .replace(INVISIBLE_AND_COMBINING_CHARS, "")
    .toLowerCase();
  const tokens = masked
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((token) => /[a-z]/u.test(token));
  if (tokens && tokens.length > 0) {
    return tokens.join(" ");
  }
  return (
    masked.replace(/\s+/gu, "") ||
    text
      .normalize("NFKC")
      .normalize("NFD")
      .replace(INVISIBLE_AND_COMBINING_CHARS, "")
      .toLowerCase()
      .replace(/\s+/gu, "")
  );
}

const ASSISTED_PASSAGE_STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "has", "had",
  "are", "was", "were", "will", "would", "could", "should", "into", "onto",
  "about", "more", "most", "some", "many", "such", "very", "also", "than",
  "then", "they", "them", "their", "there", "these", "those", "only", "just",
  "can", "not", "but", "all", "one", "two", "its", "our", "you", "your",
  "to", "of", "in", "on", "at", "by", "as", "is", "be", "an", "or", "if",
  "it", "so", "no", "up", "do", "we", "he", "she", "who", "when", "where",
  "which", "what", "while", "how", "why",
]);

const PASSAGE_PARAGRAPH_BREAK = /\n\s*\n+/u;
const PASSAGE_SENTENCE_BREAK = /(?<=[.!?。！？])\s+|\n+/u;

export type AssistedPassage = {
  readonly key: string;
  readonly tokens: readonly string[];
  readonly tokenSet: ReadonlySet<string>;
  readonly contentTokenSet: ReadonlySet<string>;
};

export type AssistedFingerprint = {
  readonly key: string;
  readonly tokens: readonly string[];
  readonly tokenSet: ReadonlySet<string>;
  readonly shingles: ReadonlySet<string>;
  readonly shingles9: ReadonlySet<string>;
  readonly shortCueShingles7: ReadonlySet<string>;
  readonly passages: readonly AssistedPassage[];
};

function buildContiguousShingles(tokens: readonly string[], size: number): Set<string> {
  const result = new Set<string>();
  if (tokens.length < size) return result;
  for (let i = 0; i <= tokens.length - size; i += 1) {
    result.add(tokens.slice(i, i + size).join(" "));
  }
  return result;
}

function collectContentTokens(tokens: readonly string[]): Set<string> {
  const content = new Set<string>();
  for (const token of tokens) {
    if (token.length >= 3 && !ASSISTED_PASSAGE_STOP_WORDS.has(token)) {
      content.add(token);
    }
  }
  return content;
}

function extractSubstantivePassages(text: string): {
  readonly passages: AssistedPassage[];
  readonly shortCueShingles7: Set<string>;
} {
  const seen = new Set<string>();
  const passages: AssistedPassage[] = [];
  const shortCueShingles7 = new Set<string>();

  const rawChunks: string[] = [];
  for (const paragraph of text.split(PASSAGE_PARAGRAPH_BREAK)) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) continue;
    rawChunks.push(trimmedParagraph);
    for (const sentence of trimmedParagraph.split(PASSAGE_SENTENCE_BREAK)) {
      const trimmedSentence = sentence.trim();
      if (trimmedSentence && trimmedSentence !== trimmedParagraph) {
        rawChunks.push(trimmedSentence);
      }
    }
  }

  for (const chunk of rawChunks) {
    const chunkKey = normalizeAssistedTextKey(chunk);
    if (!chunkKey || seen.has(chunkKey)) continue;
    seen.add(chunkKey);
    const chunkTokens = chunkKey.split(" ").filter(Boolean);
    if (chunkTokens.length >= 7 && chunkTokens.length < 9) {
      for (const shingle of buildContiguousShingles(chunkTokens, 7)) {
        shortCueShingles7.add(shingle);
      }
    }
    const contentTokenSet = collectContentTokens(chunkTokens);
    const isSubstantive =
      chunkTokens.length >= 10 ||
      (contentTokenSet.size >= 8 && chunkKey.length >= 45);
    if (isSubstantive) {
      passages.push({
        key: chunkKey,
        tokens: chunkTokens,
        tokenSet: new Set(chunkTokens),
        contentTokenSet,
      });
    }
  }

  return { passages, shortCueShingles7 };
}

function hasHighLocalPassageContainment(
  candidateTokens: readonly string[],
  passage: AssistedPassage,
): boolean {
  const requiredRatio = 0.8;
  const targetSize = passage.tokenSet.size;
  const contentTargetSize = passage.contentTokenSet.size;
  if (targetSize === 0 || candidateTokens.length === 0) return false;

  // Strictly local sliding window bounded near the passage's own length avoids
  // whole-essay/whole-paragraph bag-of-words false positives while catching
  // near-verbatim sentence or paragraph copies even when minor edits break 9-word shingles.
  const windowSize = Math.min(
    candidateTokens.length,
    Math.max(passage.tokens.length + 3, Math.ceil(passage.tokens.length * 1.25)),
  );
  if (windowSize < Math.ceil(targetSize * requiredRatio)) {
    return false;
  }
  const windowCounts = new Map<string, number>();
  let matchedDistinct = 0;
  let matchedContentDistinct = 0;
  for (let i = 0; i < candidateTokens.length; i += 1) {
    const added = candidateTokens[i]!;
    if (passage.tokenSet.has(added)) {
      const prev = windowCounts.get(added) ?? 0;
      windowCounts.set(added, prev + 1);
      if (prev === 0) {
        matchedDistinct += 1;
        if (passage.contentTokenSet.has(added)) matchedContentDistinct += 1;
      }
    }
    if (i >= windowSize) {
      const removed = candidateTokens[i - windowSize]!;
      if (passage.tokenSet.has(removed)) {
        const next = (windowCounts.get(removed) ?? 1) - 1;
        if (next <= 0) {
          windowCounts.delete(removed);
          matchedDistinct -= 1;
          if (passage.contentTokenSet.has(removed)) matchedContentDistinct -= 1;
        } else {
          windowCounts.set(removed, next);
        }
      }
    }
    if (
      matchedDistinct / targetSize >= requiredRatio &&
      (contentTargetSize === 0 || matchedContentDistinct / contentTargetSize >= requiredRatio)
    ) {
      return true;
    }
  }
  return false;
}

export function buildAssistedFingerprint(text: string): AssistedFingerprint | null {
  const key = normalizeAssistedTextKey(text);
  if (!key) return null;
  const tokens = key.split(" ").filter(Boolean);
  const tokenSet = new Set(tokens);
  const shingleSize = tokens.length >= 5 ? 5 : 4;
  const shingles = buildContiguousShingles(tokens, shingleSize);
  const shingles9 = buildContiguousShingles(tokens, 9);
  const { passages, shortCueShingles7 } = extractSubstantivePassages(text);
  if (tokens.length >= 7 && tokens.length < 9) {
    for (const shingle of buildContiguousShingles(tokens, 7)) {
      shortCueShingles7.add(shingle);
    }
  }
  return { key, tokens, tokenSet, shingles, shingles9, shortCueShingles7, passages };
}

export function collectAssistedFingerprints(texts: readonly string[]): AssistedFingerprint[] {
  const byKey = new Map<string, AssistedFingerprint>();
  for (const text of texts) {
    const fp = buildAssistedFingerprint(text);
    if (fp && !byKey.has(fp.key)) {
      byKey.set(fp.key, fp);
    }
  }
  return [...byKey.values()];
}

/**
 * Checks whether a candidate submission matches or reuses any recorded
 * assisted/sample fingerprint via:
 * - exact normalized lexical equality (Unicode/invisible-char safe),
 * - verbatim exemplar substring reuse (>= 8 words),
 * - shared 9-word contiguous normalized shingles (or 7-word shingles for 7–8 word cues),
 * - verbatim or near-verbatim substantive paragraph/sentence reuse (>= 80% local token containment),
 * - whole-response high token Jaccard (>= 0.55) or 5-gram overlap (>= 0.40 / >= 0.55).
 */
export function matchesAssistedFingerprint(
  candidateText: string,
  fingerprints: readonly AssistedFingerprint[],
): boolean {
  if (fingerprints.length === 0) return false;
  const candidate = buildAssistedFingerprint(candidateText);
  if (!candidate) return false;

  const candidateShingles7 = buildContiguousShingles(candidate.tokens, 7);

  for (const fp of fingerprints) {
    if (candidate.key === fp.key) return true;
    if (fp.tokens.length >= 8 && candidate.key.includes(fp.key)) return true;

    if (fp.shingles9.size > 0 && candidate.shingles9.size > 0) {
      for (const shingle of fp.shingles9) {
        if (candidate.shingles9.has(shingle)) return true;
      }
    }
    if (fp.shortCueShingles7.size > 0 && candidateShingles7.size > 0) {
      for (const shingle of fp.shortCueShingles7) {
        if (candidateShingles7.has(shingle)) return true;
      }
    }

    for (const passage of fp.passages) {
      if (candidate.key.includes(passage.key)) return true;
      if (hasHighLocalPassageContainment(candidate.tokens, passage)) {
        return true;
      }
    }

    if (fp.tokens.length >= 12 && candidate.tokens.length >= 12) {
      let intersection = 0;
      for (const token of fp.tokenSet) {
        if (candidate.tokenSet.has(token)) intersection += 1;
      }
      const union = fp.tokenSet.size + candidate.tokenSet.size - intersection;
      if (union > 0 && intersection / union >= 0.55) return true;

      if (fp.shingles.size >= 4 && candidate.shingles.size >= 4) {
        let shingleHits = 0;
        for (const shingle of fp.shingles) {
          if (candidate.shingles.has(shingle)) shingleHits += 1;
        }
        const minShingles = Math.min(fp.shingles.size, candidate.shingles.size);
        if (shingleHits / fp.shingles.size >= 0.4 || shingleHits / minShingles >= 0.55) {
          return true;
        }
      }
    }
  }

  return false;
}

export type ParagraphHighlightSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "span"; readonly text: string; readonly span: IeltsSpanEvidence };

/**
 * Splits a paragraph into non-overlapping plain-text and span-highlighted segments
 * using Unicode-safe UTF-16 offset location (zero `.toLowerCase()` index drift).
 */
export function segmentParagraphWithSpans(
  paragraph: string,
  spans: readonly IeltsSpanEvidence[],
  criterionFilter: IeltsCriterion | "ALL",
): ParagraphHighlightSegment[] {
  const boundaries = graphemeBoundaries(paragraph);
  let prose: string | undefined;
  const eligible = spans
    .filter((span) => criterionFilter === "ALL" || span.criterion === criterionFilter)
    .map((span) => {
      const { startOffset, endOffset, excerpt } = span;
      if (
        startOffset !== undefined && Number.isInteger(startOffset) &&
        endOffset !== undefined && Number.isInteger(endOffset) &&
        startOffset >= 0 && endOffset > startOffset && endOffset <= paragraph.length &&
        excerpt.trim() && paragraph.slice(startOffset, endOffset) === excerpt &&
        boundaries.floor(startOffset) === startOffset && boundaries.floor(endOffset) === endOffset
      ) {
        return { span, start: startOffset, end: endOffset };
      }
      prose ??= maskIeltsMarkup(paragraph);
      const located = locateGroundedExcerpt(prose, excerpt);
      if (!located || boundaries.floor(located.startOffset) !== located.startOffset ||
        boundaries.floor(located.endOffset) !== located.endOffset) return null;
      return { span, start: located.startOffset, end: located.endOffset };
    })
    .filter(
      (entry): entry is { span: IeltsSpanEvidence; start: number; end: number } =>
        entry !== null,
    )
    .sort((a, b) => a.start - b.start || b.end - a.end);

  if (eligible.length === 0) {
    return [{ kind: "text", text: paragraph }];
  }

  const segments: ParagraphHighlightSegment[] = [];
  let cursor = 0;

  for (const item of eligible) {
    if (item.start < cursor) {
      continue;
    }
    if (item.start > cursor) {
      segments.push({ kind: "text", text: paragraph.slice(cursor, item.start) });
    }
    segments.push({
      kind: "span",
      text: paragraph.slice(item.start, item.end),
      span: item.span,
    });
    cursor = item.end;
  }

  if (cursor < paragraph.length) {
    segments.push({ kind: "text", text: paragraph.slice(cursor) });
  }

  return segments;
}
