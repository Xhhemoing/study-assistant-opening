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

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesPattern(text: string, pattern: string): boolean {
  const trimmed = pattern.trim().toLowerCase();
  if (!trimmed) return false;
  // Multi-word phrases match across flexible whitespace; single words enforce word boundaries.
  const parts = trimmed.split(/\s+/).map(escapeRegExp);
  const regex = new RegExp(`\\b${parts.join("\\s+")}\\b`, "i");
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
  const words = text.toLowerCase().match(/[a-z]{4,}(?:-[a-z]{2,})*/g) ?? [];
  return new Set(words.filter((word) => !STOP_WORDS.has(word)));
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

  const items: IeltsUpgradeTransferItem[] = input.targets.map((target) => {
    const baseHit = findMatchedPatterns(input.draft1.paragraphs, target.targetPatterns);
    const revHit = findMatchedPatterns(input.draft2.paragraphs, target.targetPatterns);
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

    let status: IeltsTransferStatus;
    let explanation: string;

    if (revCliche.matched.length > 0) {
      status = "memorized_cliche";
      explanation = `二稿中出现了模板套话（${revCliche.matched.join(" / ")}），需替换为贴合题干语境的原创表达。`;
    } else if (baseHit.matched.length > 0 && revHit.matched.length === 0) {
      status = "regressed";
      explanation = `一稿原有的目标表达（${baseHit.matched.join(" / ")}）在改写中丢失，建议恢复并完善。`;
    } else if (
      revWeak.matched.length > baseWeak.matched.length &&
      revHit.matched.length === 0
    ) {
      status = "regressed";
      explanation = `二稿新增了偏笼统或薄弱表达（${revWeak.matched.join(" / ")}），尚未替换为目标升级结构。`;
    } else if (revHit.matched.length > 0) {
      status = "transferred";
      const clearedWeak =
        baseWeak.matched.length > 0 && revWeak.matched.length < baseWeak.matched.length;
      explanation = clearedWeak
        ? `已成功替换为目标表达（${revHit.matched.join(" / ")}），并清除了原稿薄弱说法。`
        : `已在第 ${revHit.paragraphIndices.map((idx) => idx + 1).join("、")} 段自然运用目标表达（${revHit.matched.join(" / ")}）。`;
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
      revisedMatched: revHit.matched,
      matchedParagraphIndices: revHit.paragraphIndices,
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

  const minimumTransferred = totalTargets > 0 ? Math.max(1, Math.ceil(totalTargets * 0.5)) : 0;
  const meetsCrossDraftVerification =
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
      meetsCrossDraftVerification,
    },
  };
}

function firstSentenceSnippet(paragraph: string, maxChars = 130): string {
  const trimmed = paragraph.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^[^.!?]+[.!?]?/);
  const sentence = (match ? match[0] : trimmed).trim();
  if (sentence.length <= maxChars) return sentence;
  // Slice on a word boundary so the snippet stays an exact substring of the paragraph.
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
  const templatePenalty = templateHits.some((h) => h.severity === "blocking") ? 1.0 : templateHits.length > 0 ? 0.5 : 0;

  const criterionTransfers = (criterion: "TR" | "CC" | "LR" | "GRA") =>
    transferReport.items.filter((item) => item.criterion === criterion);

  const scoreCriterion = (criterion: "TR" | "CC" | "LR" | "GRA"): IeltsBandScore => {
    const related = criterionTransfers(criterion);
    const transferred = related.filter((r) => r.status === "transferred").length;
    const regressed = related.filter((r) => r.status === "regressed").length;
    const cliches = related.filter((r) => r.status === "memorized_cliche").length;
    const lengthBonus = wordCount >= 240 ? 0.5 : wordCount < 160 ? -0.5 : 0;
    const base = 6.0 + lengthBonus + transferred * 0.5 - regressed * 0.5 - cliches * 0.5;
    const penalized = criterion === "LR" || criterion === "TR" ? base - templatePenalty : base - templatePenalty * 0.5;
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

  const validated = createValidatedRubricReceipt({
    receiptId: input.receiptId,
    taskMode: "writing_task2",
    draft: { ...input.revisedDraft, paragraphs },
    assessments,
    crossDraftTransferVerified: transferReport.summary.meetsCrossDraftVerification,
    freshPromptTransfer: input.freshPromptTransfer,
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
