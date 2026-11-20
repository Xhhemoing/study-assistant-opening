import {
  IELTS_CRITERION_META,
  locateGroundedExcerpt,
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
    activeChipClass: "border-obj-2/45 bg-obj-2/12 text-obj-2 font-medium",
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
    label: "时长无效（需 60–90 秒）",
    badgeClass: "border-danger/30 bg-danger-soft text-danger",
  },
  too_short: {
    label: "时长偏短（低于 60 秒）",
    badgeClass: "border-warn/30 bg-warn-soft text-warn",
  },
  on_target: {
    label: "时长适中（60–90 秒）",
    badgeClass: "border-accent/30 bg-accent-soft text-accent",
  },
  over_time: {
    label: "略微超时（超过 90 秒）",
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
  const eligible = spans
    .filter((span) => criterionFilter === "ALL" || span.criterion === criterionFilter)
    .map((span) => {
      if (
        typeof span.startOffset === "number" &&
        typeof span.endOffset === "number" &&
        span.startOffset >= 0 &&
        span.endOffset > span.startOffset &&
        span.endOffset <= paragraph.length
      ) {
        return { span, start: span.startOffset, end: span.endOffset };
      }
      const located = locateGroundedExcerpt(paragraph, span.excerpt);
      if (!located) return null;
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
