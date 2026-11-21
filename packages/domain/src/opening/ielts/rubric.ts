import { graphemeBoundaries } from "./graphemes";
import { countProseWords, maskIeltsMarkup, maskIeltsParagraphs } from "./prose";
import {
  IELTS_CARTRIDGE_ID,
  IELTS_CRITERIA,
  type IeltsBandScore,
  type IeltsCriterion,
  type IeltsCriterionAssessment,
  type IeltsEpistemicStatus,
  type IeltsEssayDraft,
  type IeltsEvidenceSourceKind,
  type IeltsMemorizedTemplateHit,
  type IeltsRubricReceipt,
  type IeltsRubricValidationError,
  type IeltsRubricValidationResult,
  type IeltsSpanEvidence,
  type IeltsTaskMode,
  type IeltsUpgradeTarget,
} from "./types";
import { getWritingDraftSource, getWritingTransferSource } from "./writing-source";

const MIN_BAND = 4;
const MAX_BAND = 9;
const MIN_VERIFIED_WRITING_WORDS = 180;

type TemplateCatalogEntry = {
  readonly phrase: string;
  readonly severity: "warning" | "blocking";
  readonly advice: string;
};

/**
 * Curated memorized IELTS essay templates that indicate formulaic stuffing
 * rather than authentic lexical control.
 */
export const IELTS_MEMORIZED_TEMPLATE_CATALOG: readonly TemplateCatalogEntry[] = [
  {
    phrase: "with the rapid development of",
    severity: "blocking",
    advice: "去掉空泛套话开头，直接点明题目争议焦点与政策背景。",
  },
  {
    phrase: "every coin has two sides",
    severity: "blocking",
    advice: "用具体的权衡对象替代谚语式套话，例如点明短期效率与长期成本。",
  },
  {
    phrase: "it is a double-edged sword",
    severity: "blocking",
    advice: "不要用万能比喻概括正反面，直接写出具体的收益与代价。",
  },
  {
    phrase: "there is no denying the fact that",
    severity: "blocking",
    advice: "删除冗余模板句干，直接陈述核心事实或前提。",
  },
  {
    phrase: "a heated debate has been sparked",
    severity: "blocking",
    advice: "改用更贴近题干语境的表达，说明争议双方各自关注什么。",
  },
  {
    phrase: "nowadays, more and more people",
    severity: "blocking",
    advice: "避免泛化的 nowadays 开头，直接指明受影响群体或城市现象。",
  },
  {
    phrase: "as far as i am concerned",
    severity: "warning",
    advice: "改用更简洁自然的立场表达，例如 I contend that 或 In my view。",
  },
  {
    phrase: "last but not least",
    severity: "warning",
    advice: "改用体现逻辑关系的衔接词（如 Equally important / Beyond immediate cost）。",
  },
  {
    phrase: "in a nutshell",
    severity: "warning",
    advice: "该表达偏口语化，议论文结尾建议改用 In conclusion 或 Ultimately。",
  },
  {
    phrase: "from where i stand",
    severity: "warning",
    advice: "学术写作中建议改为更客观的立场句，避免过度口语化套语。",
  },
];

export function isValidIeltsBand(value: number): value is IeltsBandScore {
  if (!Number.isFinite(value)) return false;
  if (value < MIN_BAND || value > MAX_BAND) return false;
  return Math.abs(value * 2 - Math.round(value * 2)) < 1e-9;
}

export function clampToIeltsBand(raw: number): IeltsBandScore {
  const clamped = Math.min(MAX_BAND, Math.max(MIN_BAND, raw));
  const rounded = Math.floor(clamped * 2 + 0.5) / 2;
  return Math.min(MAX_BAND, Math.max(MIN_BAND, rounded)) as IeltsBandScore;
}

/**
 * Official IELTS band rounding: average of 4 criteria rounded to nearest 0.5
 * (.25 rounds up to .5, .75 rounds up to the next whole band).
 */
export function computeOverallIeltsBand(
  scores: Readonly<Record<IeltsCriterion, IeltsBandScore>>,
): IeltsBandScore {
  const sum = IELTS_CRITERIA.reduce((acc, code) => acc + scores[code], 0);
  const average = sum / IELTS_CRITERIA.length;
  return clampToIeltsBand(average);
}

export function countEnglishWords(text: string): number {
  return countProseWords(maskIeltsMarkup(text));
}

export function countDraftWords(paragraphs: readonly string[]): number {
  return countProseWords(maskIeltsParagraphs(paragraphs).join("\n"));
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFlexiblePhraseRegex(phrase: string, flags: string): RegExp {
  const tokens = phrase
    .trim()
    .split(/\s+/)
    .map(escapeRegExp);
  const pattern = tokens.join("\\s+");
  const startsWord = /^[\p{L}\p{N}]/u.test(phrase.trim());
  const endsWord = /[\p{L}\p{N}]$/u.test(phrase.trim());
  const prefix = startsWord ? "(?<![\\p{L}\\p{N}])" : "";
  const suffix = endsWord ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${prefix}${pattern}${suffix}`, flags);
}

type GroundedTemplateHit = IeltsMemorizedTemplateHit &
  Required<Pick<IeltsMemorizedTemplateHit, "startOffset" | "endOffset">>;

/**
 * Counts EVERY occurrence of memorized templates across every paragraph (global
 * match per paragraph so repeated boilerplate in the same paragraph is never missed).
 */
export function detectMemorizedTemplates(
  paragraphs: readonly string[],
): GroundedTemplateHit[] {
  const hits: GroundedTemplateHit[] = [];
  maskIeltsParagraphs(paragraphs).forEach((paragraph, paragraphIndex) => {
    if (!paragraph.trim()) return;
    for (const entry of IELTS_MEMORIZED_TEMPLATE_CATALOG) {
      const regex = buildFlexiblePhraseRegex(entry.phrase, "giu");
      for (const match of paragraph.matchAll(regex)) {
        const startOffset = match.index ?? 0;
        const endOffset = startOffset + match[0].length;
        hits.push({
          phrase: entry.phrase,
          paragraphIndex,
          severity: entry.severity,
          advice: entry.advice,
          startOffset,
          endOffset,
        });
      }
    }
  });
  return hits;
}

export function hasMemorizedTemplateStuffing(
  hits: readonly IeltsMemorizedTemplateHit[],
): boolean {
  return hits.some((hit) => hit.severity === "blocking") || hits.length >= 2;
}

type FoldedOffsetEntry = {
  readonly origStart: number;
  readonly origEnd: number;
};

/**
 * Per-code-point Unicode case-folding with exact UTF-16 `[origStart, origEnd]`
 * reverse offset mapping. Handles:
 * - Surrogate pairs (e.g. "😀")
 * - Case-expanding dotted capital I ("İ" -> "i\u0307" WITHOUT stripping \u0307,
 *   so "i\u0307stanbul" distinguishes "İstanbul" from ASCII "Istanbul")
 * - Greek final sigma equivalence ("Σ" / "σ" / "ς" -> "σ")
 * - German capital sharp S ("ẞ" -> "ß")
 */
function foldWithUtf16Offsets(text: string): {
  readonly folded: string;
  readonly map: readonly FoldedOffsetEntry[];
} {
  let folded = "";
  const map: FoldedOffsetEntry[] = [];
  let utf16Offset = 0;

  for (const ch of text) {
    const origStart = utf16Offset;
    const origEnd = utf16Offset + ch.length;
    utf16Offset = origEnd;

    const lowered = ch
      .toLowerCase()
      .replace(/\u03c2/gu, "\u03c3")
      .replace(/\u1e9e/gu, "\u00df");

    for (let i = 0; i < lowered.length; i += 1) {
      folded += lowered[i];
      map.push({ origStart, origEnd });
    }
  }

  return { folded, map };
}

/**
 * Unicode-safe excerpt locator: folds both text and query per Unicode code point
 * while tracking exact UTF-16 `[origStart, origEnd]` reverse mappings (handling
 * surrogate pairs like "😀", length-expanding case folds like "İ" -> "i\u0307"
 * without collapsing dotted/undotted I, and Greek final sigma equivalence
 * "ΟΔΥΣΣΕΎΣ" <-> "οδυσσεύς").
 * Guarantees `paragraph.slice(startOffset, endOffset) === matchedText`.
 */
export function locateGroundedExcerpt(
  paragraph: string,
  excerpt: string,
): { startOffset: number; endOffset: number; matchedText: string } | null {
  const trimmed = excerpt.trim();
  if (!trimmed) return null;

  const boundaries = graphemeBoundaries(paragraph);
  const exactIndex = paragraph.indexOf(trimmed);
  const exactEnd = exactIndex + trimmed.length;
  if (
    exactIndex >= 0 &&
    boundaries.floor(exactIndex) === exactIndex &&
    boundaries.floor(exactEnd) === exactEnd
  ) {
    return {
      startOffset: exactIndex,
      endOffset: exactEnd,
      matchedText: trimmed,
    };
  }

  const { folded: foldedParagraph, map } = foldWithUtf16Offsets(paragraph);
  const foldedNeedleTokens = trimmed
    .split(/\s+/)
    .map((token) => escapeRegExp(foldWithUtf16Offsets(token).folded))
    .filter(Boolean);
  if (foldedNeedleTokens.length === 0) return null;

  const regex = new RegExp(foldedNeedleTokens.join("\\s+"), "gu");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(foldedParagraph)) !== null) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    const startOffset = map[matchStart]!.origStart;
    const endOffset = map[matchEnd - 1]!.origEnd;
    if (
      map[matchStart - 1]?.origStart === startOffset ||
      map[matchEnd]?.origEnd === endOffset ||
      boundaries.floor(startOffset) !== startOffset ||
      boundaries.floor(endOffset) !== endOffset
    ) {
      // In Unicode mode starting inside a surrogate pair can repeat this match.
      const codePoint = foldedParagraph.codePointAt(matchStart)!;
      regex.lastIndex = matchStart + (codePoint > 0xffff ? 2 : 1);
      continue;
    }
    return {
      startOffset,
      endOffset,
      matchedText: paragraph.slice(startOffset, endOffset),
    };
  }

  return null;
}

export type EpistemicResolutionInput = {
  readonly draftVersion: number;
  readonly assisted: boolean;
  readonly crossDraftTransferVerified: boolean;
  readonly freshPromptTransfer?: boolean;
  readonly memorizedTemplateHits: readonly IeltsMemorizedTemplateHit[];
  readonly wordCount: number;
  readonly minVerifiedWords?: number;
  readonly disqualificationReason?: string;
};

export type EpistemicResolution = {
  readonly epistemicStatus: IeltsEpistemicStatus;
  readonly countsTowardMastery: boolean;
  readonly masteryQualified: boolean;
  readonly evidenceSource: IeltsEvidenceSourceKind;
  readonly epistemicReason: string;
};

/**
 * Honest evidence epistemology gate:
 * - Single-draft or assisted feedback is ALWAYS `practice_feedback` (never counts toward mastery).
 * - Memorized-template stuffing blocks formal verification.
 * - Formal `rubric_verified_evidence` requires unassisted cross-draft transfer (v2+) OR
 *   unassisted fresh-prompt transfer with zero template stuffing and sufficient length.
 */
export function resolveIeltsEpistemicStatus(
  input: EpistemicResolutionInput,
): EpistemicResolution {
  const minWords = input.minVerifiedWords ?? MIN_VERIFIED_WRITING_WORDS;

  if (input.assisted) {
    return {
      epistemicStatus: "practice_feedback",
      countsTowardMastery: false,
      masteryQualified: false,
      evidenceSource: "assisted_revision",
      epistemicReason: "本次作答包含提示或脚手架辅助，仅作练习诊断反馈，不计入正式掌握度。",
    };
  }

  if (hasMemorizedTemplateStuffing(input.memorizedTemplateHits)) {
    return {
      epistemicStatus: "practice_feedback",
      countsTowardMastery: false,
      masteryQualified: false,
      evidenceSource:
        input.draftVersion <= 1 ? "single_draft_diagnostic" : "assisted_revision",
      epistemicReason: "检测到高频模板套话堆砌，需替换为贴合语境的原创表达后才可计入量规复核证据。",
    };
  }

  if (input.wordCount < minWords) {
    return {
      epistemicStatus: "practice_feedback",
      countsTowardMastery: false,
      masteryQualified: false,
      evidenceSource: "single_draft_diagnostic",
      epistemicReason: `当前有效词数为 ${input.wordCount} 词，低于独立复核门槛（${minWords} 词），暂作为练习诊断反馈。`,
    };
  }

  if (input.disqualificationReason) {
    return {
      epistemicStatus: "practice_feedback",
      countsTowardMastery: false,
      masteryQualified: false,
      evidenceSource:
        input.draftVersion <= 1 ? "single_draft_diagnostic" : "assisted_revision",
      epistemicReason: input.disqualificationReason,
    };
  }

  if (input.freshPromptTransfer) {
    return {
      epistemicStatus: "rubric_verified_evidence",
      countsTowardMastery: true,
      masteryQualified: true,
      evidenceSource: "unassisted_fresh_prompt_transfer",
      epistemicReason: "独立完成新题迁移作答且未检测到模板套话，已确认为量规复核证据。",
    };
  }

  if (input.draftVersion >= 2 && input.crossDraftTransferVerified) {
    return {
      epistemicStatus: "rubric_verified_evidence",
      countsTowardMastery: true,
      masteryQualified: true,
      evidenceSource: "unassisted_cross_draft_transfer",
      epistemicReason: "独立完成多稿精修并确认核心改写目标已迁移落地，已确认为量规复核证据。",
    };
  }

  return {
    epistemicStatus: "practice_feedback",
    countsTowardMastery: false,
    masteryQualified: false,
    evidenceSource: "single_draft_diagnostic",
    epistemicReason:
      input.draftVersion <= 1
        ? "单稿初评仅用于定位改写方向，不计入正式掌握度；完成独立二稿迁移后将升级为量规复核证据。"
        : "当前改写尚未达到跨草稿迁移确认标准，暂保留为练习诊断反馈。",
  };
}

type DraftLineage = Pick<IeltsEssayDraft, "promptId" | "version" | "basedOnVersion">;

export function getWritingTransferLineage(
  baseline: DraftLineage | undefined,
  revised: DraftLineage,
): "advancing_revision" | "fresh_prompt" | null {
  if (
    !baseline ||
    !Number.isSafeInteger(baseline.version) || baseline.version < 1 ||
    !Number.isSafeInteger(revised.version) || revised.version < 1
  ) {
    return null;
  }
  const parent = revised.basedOnVersion;
  // The supplied baseline is the only draft available to verify an explicit parent.
  if (parent !== undefined && (parent !== baseline.version || parent >= revised.version)) {
    return null;
  }
  if (revised.promptId !== baseline.promptId) return "fresh_prompt";
  const followsBaseline = parent !== undefined || revised.version === baseline.version + 1;
  return followsBaseline ? "advancing_revision" : null;
}

export type CreateRubricReceiptInput = {
  readonly receiptId: string;
  readonly taskMode: IeltsTaskMode;
  readonly draft: IeltsEssayDraft;
  readonly baselineDraft?: DraftLineage & Pick<IeltsEssayDraft, "paragraphs"> &
    Partial<Pick<IeltsEssayDraft, "draftId" | "assisted">>;
  readonly transferTargets?: readonly IeltsUpgradeTarget[];
  readonly assessments: readonly IeltsCriterionAssessment[];
  readonly crossDraftTransferVerified: boolean;
  readonly freshPromptTransfer?: boolean;
  readonly minVerifiedWords?: number;
  readonly disqualificationReason?: string;
  readonly createdAt?: string;
};

/**
 * Validates all 4 IELTS criteria (TR/CC/LR/GRA), strict 4.0-9.0 (0.5 step) bands,
 * mandatory paragraph-grounded textual evidence spans, and honest epistemic status.
 */
export function createValidatedRubricReceipt(
  input: CreateRubricReceiptInput,
): IeltsRubricValidationResult {
  const errors: IeltsRubricValidationError[] = [];
  const paragraphs = input.draft.paragraphs;
  const prose = maskIeltsParagraphs(paragraphs);
  const wordCount = countProseWords(prose.join("\n"));

  if (wordCount === 0) {
    errors.push({
      code: "EMPTY_DRAFT",
      message: "Draft must contain at least one word.",
    });
  }

  const byCriterion = new Map<IeltsCriterion, IeltsCriterionAssessment>();
  for (const assessment of input.assessments) {
    byCriterion.set(assessment.criterion, assessment);
  }

  const groundedCriteria = {} as Record<IeltsCriterion, IeltsCriterionAssessment>;
  const bandMap = {} as Record<IeltsCriterion, IeltsBandScore>;

  for (const criterion of IELTS_CRITERIA) {
    const assessment = byCriterion.get(criterion);
    if (!assessment) {
      errors.push({
        code: "MISSING_CRITERION",
        criterion,
        message: `Missing required IELTS criterion assessment: ${criterion}.`,
      });
      continue;
    }

    if (!isValidIeltsBand(assessment.band)) {
      errors.push({
        code: "INVALID_BAND",
        criterion,
        message: `Criterion ${criterion} band (${String(assessment.band)}) must be between 4.0 and 9.0 in 0.5 steps.`,
      });
    } else {
      bandMap[criterion] = assessment.band;
    }

    if (!assessment.evidenceSpans || assessment.evidenceSpans.length === 0) {
      errors.push({
        code: "MISSING_EVIDENCE_SPANS",
        criterion,
        message: `Criterion ${criterion} must include at least one span-grounded textual evidence quote.`,
      });
      continue;
    }

    const groundedSpans: IeltsSpanEvidence[] = [];
    for (const span of assessment.evidenceSpans) {
      if (span.criterion !== criterion) {
        errors.push({
          code: "CRITERION_MISMATCH",
          criterion,
          spanId: span.id,
          message: `Span ${span.id} declares criterion ${span.criterion} inside ${criterion} assessment.`,
        });
        continue;
      }

      if (
        !span.excerpt.trim() ||
        !span.diagnosis.trim() ||
        !span.upgradeRewrite.trim()
      ) {
        errors.push({
          code: "EMPTY_SPAN_FIELD",
          criterion,
          spanId: span.id,
          message: `Span ${span.id} must provide non-empty excerpt, diagnosis, and upgradeRewrite.`,
        });
        continue;
      }

      if (
        !Number.isInteger(span.paragraphIndex) ||
        span.paragraphIndex < 0 ||
        span.paragraphIndex >= paragraphs.length
      ) {
        errors.push({
          code: "PARAGRAPH_OUT_OF_RANGE",
          criterion,
          spanId: span.id,
          message: `Span ${span.id} references paragraphIndex ${span.paragraphIndex}, outside 0..${paragraphs.length - 1}.`,
        });
        continue;
      }

      const paragraphText = paragraphs[span.paragraphIndex] ?? "";
      const { startOffset, endOffset, excerpt } = span;
      let located: ReturnType<typeof locateGroundedExcerpt> = null;
      if (startOffset === undefined && endOffset === undefined) {
        const proseLocated = locateGroundedExcerpt(prose[span.paragraphIndex]!, excerpt);
        if (proseLocated) {
          const boundaries = graphemeBoundaries(paragraphText);
          if (
            boundaries.floor(proseLocated.startOffset) === proseLocated.startOffset &&
            boundaries.floor(proseLocated.endOffset) === proseLocated.endOffset
          ) {
            located = {
              ...proseLocated,
              matchedText: paragraphText.slice(proseLocated.startOffset, proseLocated.endOffset),
            };
          }
        }
      } else if (
        startOffset !== undefined && Number.isInteger(startOffset) &&
        endOffset !== undefined && Number.isInteger(endOffset) &&
        startOffset >= 0 && endOffset > startOffset && endOffset <= paragraphText.length &&
        paragraphText.slice(startOffset, endOffset) === excerpt
      ) {
        const boundaries = graphemeBoundaries(paragraphText);
        if (boundaries.floor(startOffset) === startOffset && boundaries.floor(endOffset) === endOffset) {
          located = { startOffset, endOffset, matchedText: excerpt };
        }
      }
      if (!located || !prose[span.paragraphIndex]!.slice(located.startOffset, located.endOffset).trim()) {
        errors.push({
          code: "EXCERPT_NOT_GROUNDED",
          criterion,
          spanId: span.id,
          message: `Span ${span.id} excerpt "${span.excerpt}" does not exist in paragraph ${span.paragraphIndex}.`,
        });
        continue;
      }

      groundedSpans.push({
        ...span,
        excerpt: located.matchedText,
        startOffset: located.startOffset,
        endOffset: located.endOffset,
      });
    }

    if (groundedSpans.length > 0 && isValidIeltsBand(assessment.band)) {
      groundedCriteria[criterion] = {
        ...assessment,
        evidenceSpans: groundedSpans,
      };
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const memorizedTemplateFlags = detectMemorizedTemplates(paragraphs);
  const lineage = getWritingTransferLineage(input.baselineDraft, input.draft);
  const hasBaselineText = lineage !== null && countDraftWords(input.baselineDraft?.paragraphs ?? []) > 0;
  const epistemic = resolveIeltsEpistemicStatus({
    draftVersion: input.draft.version,
    assisted: input.draft.assisted,
    crossDraftTransferVerified: lineage === "advancing_revision" && hasBaselineText && input.crossDraftTransferVerified,
    freshPromptTransfer: lineage === "fresh_prompt" && hasBaselineText && input.freshPromptTransfer,
    memorizedTemplateHits: memorizedTemplateFlags,
    wordCount,
    minVerifiedWords: input.minVerifiedWords,
    disqualificationReason: input.disqualificationReason,
  });

  const baseline = input.baselineDraft;
  const transferSource = baseline?.draftId !== undefined && baseline.assisted !== undefined && input.transferTargets
    ? getWritingTransferSource({ ...baseline, draftId: baseline.draftId, assisted: baseline.assisted }, input.transferTargets)
    : undefined;
  const receipt: IeltsRubricReceipt = {
    receiptId: input.receiptId,
    cartridgeId: IELTS_CARTRIDGE_ID,
    taskMode: input.taskMode,
    promptId: input.draft.promptId,
    draftId: input.draft.draftId,
    draftVersion: input.draft.version,
    sourceDraft: getWritingDraftSource(input.draft),
    transferSource,
    overallBand: computeOverallIeltsBand(bandMap),
    criteria: groundedCriteria,
    epistemicStatus: epistemic.epistemicStatus,
    countsTowardMastery: epistemic.countsTowardMastery,
    masteryQualified: epistemic.masteryQualified,
    epistemicReason: epistemic.epistemicReason,
    evidenceSource: epistemic.evidenceSource,
    memorizedTemplateFlags,
    wordCount,
    createdAt: input.createdAt ?? input.draft.createdAt,
  };

  return { ok: true, receipt };
}

const VALID_EVIDENCE_SOURCES: ReadonlySet<IeltsEvidenceSourceKind> = new Set([
  "single_draft_diagnostic",
  "assisted_revision",
  "unassisted_cross_draft_transfer",
  "unassisted_fresh_prompt_transfer",
]);

const VALID_UPGRADE_CATEGORIES: ReadonlySet<string> = new Set([
  "targetCollocations",
  "syntacticStructures",
  "cohesiveDevices",
  "counterargumentDepth",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDraftSourceRecord(
  value: unknown,
  label: string,
  issues: string[],
): value is IeltsEssayDraft {
  if (!isPlainRecord(value)) {
    issues.push(`${label} must be a plain object`);
    return false;
  }
  const initialCount = issues.length;
  if (!isNonBlankString(value.draftId)) issues.push(`${label}.draftId must be a non-blank string`);
  if (!isNonBlankString(value.promptId)) issues.push(`${label}.promptId must be a non-blank string`);
  if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1) {
    issues.push(`${label}.version must be a positive integer`);
  }
  if (
    value.basedOnVersion !== undefined &&
    (typeof value.basedOnVersion !== "number" ||
      !Number.isSafeInteger(value.basedOnVersion) ||
      value.basedOnVersion < 1 ||
      (typeof value.version === "number" && value.basedOnVersion >= value.version))
  ) {
    issues.push(`${label}.basedOnVersion must be a positive integer lower than version`);
  }
  if (typeof value.assisted !== "boolean") issues.push(`${label}.assisted must be a boolean`);
  if (
    !Array.isArray(value.paragraphs) ||
    value.paragraphs.length === 0 ||
    !value.paragraphs.every((paragraph) => typeof paragraph === "string")
  ) {
    issues.push(`${label}.paragraphs must be a non-empty string array`);
  }
  return issues.length === initialCount;
}

export type ValidateWritingRubricReceiptOptions = {
  readonly requireVerifiedMastery?: boolean;
  readonly expectedPromptId?: string;
  readonly expectedDraftId?: string;
};

/**
 * Fail-closed structural and provenance validation for a serialized or externally
 * supplied IELTS Writing Task 2 rubric receipt. Re-verifies sourceDraft identity,
 * word count, transferSource lineage (when present), 4-criterion band math,
 * span grounding against sourceDraft.paragraphs, template stuffing, and epistemic claims.
 */
export function validateWritingRubricReceipt(
  rawReceipt: unknown,
  options?: ValidateWritingRubricReceiptOptions,
): { readonly ok: true; readonly receipt: IeltsRubricReceipt } | { readonly ok: false; readonly issues: readonly string[] } {
  const issues: string[] = [];
  if (!isPlainRecord(rawReceipt)) {
    return { ok: false, issues: ["writing receipt must be a plain object"] };
  }

  if (!isNonBlankString(rawReceipt.receiptId)) issues.push("receiptId must be a non-blank string");
  if (rawReceipt.cartridgeId !== IELTS_CARTRIDGE_ID) issues.push("cartridgeId mismatch");
  if (rawReceipt.taskMode !== "writing_task2") issues.push("taskMode must be writing_task2");
  if (!isNonBlankString(rawReceipt.promptId)) issues.push("promptId must be a non-blank string");
  if (!isNonBlankString(rawReceipt.draftId)) issues.push("draftId must be a non-blank string");
  if (
    typeof rawReceipt.draftVersion !== "number" ||
    !Number.isSafeInteger(rawReceipt.draftVersion) ||
    rawReceipt.draftVersion < 1
  ) {
    issues.push("draftVersion must be a positive integer");
  }
  if (typeof rawReceipt.overallBand !== "number" || !isValidIeltsBand(rawReceipt.overallBand)) {
    issues.push("overallBand must be a valid IELTS band score");
  }
  if (
    rawReceipt.epistemicStatus !== "practice_feedback" &&
    rawReceipt.epistemicStatus !== "rubric_verified_evidence"
  ) {
    issues.push("invalid epistemicStatus");
  }
  if (typeof rawReceipt.countsTowardMastery !== "boolean") issues.push("countsTowardMastery must be a boolean");
  if (typeof rawReceipt.masteryQualified !== "boolean") issues.push("masteryQualified must be a boolean");
  if (!isNonBlankString(rawReceipt.epistemicReason)) issues.push("epistemicReason must be a non-blank string");
  if (
    typeof rawReceipt.evidenceSource !== "string" ||
    !VALID_EVIDENCE_SOURCES.has(rawReceipt.evidenceSource as IeltsEvidenceSourceKind)
  ) {
    issues.push("invalid evidenceSource");
  }
  if (
    typeof rawReceipt.wordCount !== "number" ||
    !Number.isSafeInteger(rawReceipt.wordCount) ||
    rawReceipt.wordCount < 1
  ) {
    issues.push("wordCount must be a positive integer");
  }
  if (!isNonBlankString(rawReceipt.createdAt)) issues.push("createdAt must be a non-blank string");
  if (!Array.isArray(rawReceipt.memorizedTemplateFlags)) {
    issues.push("memorizedTemplateFlags must be an array");
  }

  if (options?.expectedPromptId !== undefined && rawReceipt.promptId !== options.expectedPromptId) {
    issues.push("promptId does not match expectedPromptId");
  }
  if (options?.expectedDraftId !== undefined && rawReceipt.draftId !== options.expectedDraftId) {
    issues.push("draftId does not match expectedDraftId");
  }

  const rawSourceDraft = rawReceipt.sourceDraft;
  const hasValidSourceDraft = isValidDraftSourceRecord(rawSourceDraft, "sourceDraft", issues);
  if (isValidDraftSourceRecord(rawSourceDraft, "sourceDraft", [])) {
    if (rawSourceDraft.draftId !== rawReceipt.draftId) issues.push("sourceDraft.draftId mismatch");
    if (rawSourceDraft.promptId !== rawReceipt.promptId) issues.push("sourceDraft.promptId mismatch");
    if (rawSourceDraft.version !== rawReceipt.draftVersion) issues.push("sourceDraft.version mismatch");
  }

  let validatedBaseline: (DraftLineage & Pick<IeltsEssayDraft, "paragraphs"> & Partial<Pick<IeltsEssayDraft, "draftId" | "assisted">>) | undefined;
  let validatedTargets: readonly IeltsUpgradeTarget[] | undefined;

  if (rawReceipt.transferSource !== undefined) {
    if (!isPlainRecord(rawReceipt.transferSource)) {
      issues.push("transferSource must be a plain object");
    } else {
      const rawBaseline = rawReceipt.transferSource.baseline;
      if (isValidDraftSourceRecord(rawBaseline, "transferSource.baseline", issues)) {
        if (countDraftWords(rawBaseline.paragraphs) === 0) {
          issues.push("transferSource.baseline must contain prose words");
        } else {
          validatedBaseline = {
            draftId: rawBaseline.draftId,
            promptId: rawBaseline.promptId,
            version: rawBaseline.version,
            basedOnVersion: rawBaseline.basedOnVersion,
            assisted: rawBaseline.assisted,
            paragraphs: rawBaseline.paragraphs,
          };
        }
      }
      if (!Array.isArray(rawReceipt.transferSource.targets)) {
        issues.push("transferSource.targets must be an array");
      } else {
        for (const [index, target] of rawReceipt.transferSource.targets.entries()) {
          if (
            !isPlainRecord(target) ||
            !isNonBlankString(target.id) ||
            !isNonBlankString(target.label) ||
            !isNonBlankString(target.guidance) ||
            typeof target.category !== "string" ||
            !VALID_UPGRADE_CATEGORIES.has(target.category) ||
            !IELTS_CRITERIA.includes(target.criterion as IeltsCriterion) ||
            !Array.isArray(target.targetPatterns) ||
            target.targetPatterns.length === 0 ||
            !target.targetPatterns.every((pattern) => isNonBlankString(pattern))
          ) {
            issues.push(`transferSource.targets[${index}] is invalid`);
          }
        }
        validatedTargets = rawReceipt.transferSource.targets as readonly IeltsUpgradeTarget[];
      }
    }
  }

  const assessments: IeltsCriterionAssessment[] = [];
  if (!isPlainRecord(rawReceipt.criteria)) {
    issues.push("criteria must be a plain object");
  } else {
    for (const criterion of IELTS_CRITERIA) {
      const entry = rawReceipt.criteria[criterion];
      if (!isPlainRecord(entry)) {
        issues.push(`criteria.${criterion} must be a plain object`);
        continue;
      }
      if (entry.criterion !== criterion) issues.push(`criteria.${criterion}.criterion mismatch`);
      if (typeof entry.band !== "number" || !isValidIeltsBand(entry.band)) {
        issues.push(`criteria.${criterion}.band is invalid`);
      }
      if (!isNonBlankString(entry.summary)) {
        issues.push(`criteria.${criterion}.summary must be a non-blank string`);
      }
      if (!Array.isArray(entry.evidenceSpans) || entry.evidenceSpans.length === 0) {
        issues.push(`criteria.${criterion}.evidenceSpans must be a non-empty array`);
        continue;
      }
      const spans: IeltsSpanEvidence[] = [];
      for (const [spanIdx, rawSpan] of entry.evidenceSpans.entries()) {
        if (
          !isPlainRecord(rawSpan) ||
          !isNonBlankString(rawSpan.id) ||
          typeof rawSpan.paragraphIndex !== "number" ||
          !isNonBlankString(rawSpan.excerpt) ||
          !isNonBlankString(rawSpan.diagnosis) ||
          !isNonBlankString(rawSpan.upgradeRewrite) ||
          !IELTS_CRITERIA.includes(rawSpan.criterion as IeltsCriterion) ||
          (rawSpan.startOffset !== undefined && typeof rawSpan.startOffset !== "number") ||
          (rawSpan.endOffset !== undefined && typeof rawSpan.endOffset !== "number")
        ) {
          issues.push(`criteria.${criterion}.evidenceSpans[${spanIdx}] is invalid`);
          continue;
        }
        spans.push({
          id: rawSpan.id,
          paragraphIndex: rawSpan.paragraphIndex,
          excerpt: rawSpan.excerpt,
          criterion: rawSpan.criterion as IeltsCriterion,
          diagnosis: rawSpan.diagnosis,
          upgradeRewrite: rawSpan.upgradeRewrite,
          ...(rawSpan.startOffset !== undefined ? { startOffset: rawSpan.startOffset } : {}),
          ...(rawSpan.endOffset !== undefined ? { endOffset: rawSpan.endOffset } : {}),
        });
      }
      if (spans.length === entry.evidenceSpans.length && typeof entry.band === "number" && isValidIeltsBand(entry.band)) {
        assessments.push({
          criterion,
          band: entry.band,
          summary: String(entry.summary ?? ""),
          evidenceSpans: spans,
        });
      }
    }
  }

  if (issues.length > 0 || !hasValidSourceDraft) {
    return { ok: false, issues };
  }

  const receipt = rawReceipt as IeltsRubricReceipt;
  const sourceDraft = receipt.sourceDraft!;
  const isCrossDraftTransfer = receipt.evidenceSource === "unassisted_cross_draft_transfer";
  const isFreshPromptTransfer = receipt.evidenceSource === "unassisted_fresh_prompt_transfer";
  const claimsVerified =
    receipt.epistemicStatus === "rubric_verified_evidence" ||
    receipt.countsTowardMastery ||
    receipt.masteryQualified;

  if (validatedBaseline) {
    const lineage = getWritingTransferLineage(validatedBaseline, sourceDraft);
    if (isCrossDraftTransfer && lineage !== "advancing_revision") {
      issues.push("transferSource.baseline does not establish advancing_revision lineage");
    }
    if (isFreshPromptTransfer && lineage !== "fresh_prompt") {
      issues.push("transferSource.baseline does not establish fresh_prompt lineage");
    }
  } else if (isCrossDraftTransfer && sourceDraft.version < 2) {
    issues.push("unassisted_cross_draft_transfer requires draftVersion >= 2");
  }

  const effectiveBaseline =
    validatedBaseline ??
    (isCrossDraftTransfer && sourceDraft.version >= 2
      ? {
          promptId: sourceDraft.promptId,
          version: sourceDraft.basedOnVersion ?? sourceDraft.version - 1,
          paragraphs: ["baseline"],
        }
      : isFreshPromptTransfer
        ? {
            promptId: `${sourceDraft.promptId}:baseline`,
            version: 1,
            paragraphs: ["baseline"],
          }
        : undefined);

  const recomputed = createValidatedRubricReceipt({
    receiptId: receipt.receiptId,
    taskMode: "writing_task2",
    draft: {
      draftId: sourceDraft.draftId,
      promptId: sourceDraft.promptId,
      version: sourceDraft.version,
      basedOnVersion: sourceDraft.basedOnVersion,
      assisted: sourceDraft.assisted,
      paragraphs: sourceDraft.paragraphs,
      label: "",
      timeSpentSeconds: 0,
      timeBoxSeconds: 0,
      createdAt: receipt.createdAt,
    },
    baselineDraft: effectiveBaseline,
    transferTargets: validatedTargets,
    assessments,
    crossDraftTransferVerified: isCrossDraftTransfer,
    freshPromptTransfer: isFreshPromptTransfer,
    createdAt: receipt.createdAt,
  });

  if (!recomputed.ok) {
    for (const err of recomputed.errors) {
      issues.push(`${err.code}: ${err.message}`);
    }
    return { ok: false, issues };
  }

  if (recomputed.receipt.overallBand !== receipt.overallBand) {
    issues.push("overallBand does not match criterion bands");
  }
  if (recomputed.receipt.wordCount !== receipt.wordCount) {
    issues.push("wordCount does not match sourceDraft prose");
  }

  if (options?.requireVerifiedMastery || claimsVerified) {
    if (
      receipt.epistemicStatus !== "rubric_verified_evidence" ||
      receipt.countsTowardMastery !== true ||
      receipt.masteryQualified !== true
    ) {
      issues.push("verified receipt must have consistent rubric_verified_evidence mastery flags");
    }
    if (!isCrossDraftTransfer && !isFreshPromptTransfer) {
      issues.push("verified receipt requires unassisted transfer evidenceSource");
    }
    if (sourceDraft.assisted !== false) {
      issues.push("verified receipt cannot originate from an assisted sourceDraft");
    }
    if (
      recomputed.receipt.epistemicStatus !== "rubric_verified_evidence" ||
      recomputed.receipt.countsTowardMastery !== true ||
      recomputed.receipt.masteryQualified !== true
    ) {
      issues.push("sourceDraft failed authoritative rubric verification");
    }
  } else {
    if (
      receipt.epistemicStatus !== "practice_feedback" ||
      receipt.countsTowardMastery !== false ||
      receipt.masteryQualified !== false
    ) {
      issues.push("practice receipt must not claim mastery");
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, receipt };
}

export function isVerifiedWritingReceipt(
  receipt: unknown,
  options?: Omit<ValidateWritingRubricReceiptOptions, "requireVerifiedMastery">,
): receipt is IeltsRubricReceipt {
  return validateWritingRubricReceipt(receipt, { ...options, requireVerifiedMastery: true }).ok;
}
