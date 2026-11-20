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
} from "./types";

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
  const tokens = text.trim().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return tokens ? tokens.length : 0;
}

export function countDraftWords(paragraphs: readonly string[]): number {
  return paragraphs.reduce((total, paragraph) => total + countEnglishWords(paragraph), 0);
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

/**
 * Counts EVERY occurrence of memorized templates across every paragraph (global
 * match per paragraph so repeated boilerplate in the same paragraph is never missed).
 */
export function detectMemorizedTemplates(
  paragraphs: readonly string[],
): IeltsMemorizedTemplateHit[] {
  const hits: IeltsMemorizedTemplateHit[] = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
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

/**
 * Unicode-safe excerpt locator: matches directly against the original UTF-16 string
 * using exact search or `/.../iu` regex without `.toLowerCase()` length-drift (e.g. "İ" -> "i\u0307").
 * Guarantees `paragraph.slice(startOffset, endOffset)` aligns 100% with the matched text.
 */
export function locateGroundedExcerpt(
  paragraph: string,
  excerpt: string,
): { startOffset: number; endOffset: number; matchedText: string } | null {
  const trimmed = excerpt.trim();
  if (!trimmed) return null;

  const exactIndex = paragraph.indexOf(trimmed);
  if (exactIndex !== -1) {
    return {
      startOffset: exactIndex,
      endOffset: exactIndex + trimmed.length,
      matchedText: paragraph.slice(exactIndex, exactIndex + trimmed.length),
    };
  }

  const escapedTokens = trimmed
    .split(/\s+/)
    .map(escapeRegExp);
  const regex = new RegExp(escapedTokens.join("\\s+"), "iu");
  const match = regex.exec(paragraph);
  if (match && typeof match.index === "number") {
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;
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

export type CreateRubricReceiptInput = {
  readonly receiptId: string;
  readonly taskMode: IeltsTaskMode;
  readonly draft: IeltsEssayDraft;
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

  if (!paragraphs.length || paragraphs.every((p) => p.trim().length === 0)) {
    errors.push({
      code: "EMPTY_DRAFT",
      message: "Draft must contain at least one non-empty paragraph.",
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
      const located = locateGroundedExcerpt(paragraphText, span.excerpt);
      if (!located) {
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

  const wordCount = countDraftWords(paragraphs);
  const memorizedTemplateFlags = detectMemorizedTemplates(paragraphs);
  const epistemic = resolveIeltsEpistemicStatus({
    draftVersion: input.draft.version,
    assisted: input.draft.assisted,
    crossDraftTransferVerified: input.crossDraftTransferVerified,
    freshPromptTransfer: input.freshPromptTransfer,
    memorizedTemplateHits: memorizedTemplateFlags,
    wordCount,
    minVerifiedWords: input.minVerifiedWords,
    disqualificationReason: input.disqualificationReason,
  });

  const receipt: IeltsRubricReceipt = {
    receiptId: input.receiptId,
    cartridgeId: IELTS_CARTRIDGE_ID,
    taskMode: input.taskMode,
    promptId: input.draft.promptId,
    draftId: input.draft.draftId,
    draftVersion: input.draft.version,
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
