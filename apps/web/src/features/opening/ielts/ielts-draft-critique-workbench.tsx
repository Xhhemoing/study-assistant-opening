"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  IELTS_CRITERIA,
  IELTS_CRITERION_META,
  analyzeCrossDraftTransfer,
  countDraftWords,
  evaluateRevisedDraftDeterministically,
  getWritingDraftSource,
  getWritingTransferSource,
  type IeltsCriterion,
  type IeltsCrossDraftTransferReport,
  type IeltsEssayDraft,
  type IeltsRubricReceipt,
  type IeltsSpanEvidence,
} from "./domain-bridge";
import {
  IELTS_WRITING_SPEAKING_FIXTURE,
  type IeltsWorkbenchFixture,
} from "./ielts-fixtures";
import {
  CRITERION_STYLES,
  EPISTEMIC_BADGE_META,
  TRANSFER_STATUS_META,
  UPGRADE_CATEGORY_LABELS,
  formatBandScore,
  formatTimeBox,
  normalizeAssistedTextKey,
  segmentParagraphWithSpans,
  type DraftViewMode,
} from "./workbench-model";

export type IeltsDraftCritiqueWorkbenchProps = {
  readonly fixture?: IeltsWorkbenchFixture;
  readonly initialView?: DraftViewMode;
  readonly initialDraft?: string;
  readonly demoFixtureMode?: boolean;
  readonly onRevisionEvaluated?: (payload: {
    readonly revisedDraft: IeltsEssayDraft;
    readonly receipt: IeltsRubricReceipt;
    readonly transferReport: IeltsCrossDraftTransferReport;
  }) => void;
};

const VIEW_TABS: readonly { readonly id: DraftViewMode; readonly label: string }[] = [
  { id: "draft1", label: "一稿" },
  { id: "draft2", label: "二稿" },
  { id: "compare", label: "对照视图" },
];

const DIFF_STATUS_LABEL: Readonly<
  Record<"unchanged" | "revised" | "added" | "removed", string>
> = {
  unchanged: "未改动",
  revised: "已改写",
  added: "新增段落",
  removed: "已删去",
};

function collectAllSpans(receipt: IeltsRubricReceipt): IeltsSpanEvidence[] {
  return IELTS_CRITERIA.flatMap((code) => receipt.criteria[code].evidenceSpans);
}

function draftIdentity(draft: IeltsEssayDraft) {
  return [draft.promptId, draft.draftId, draft.version, draft.basedOnVersion, draft.assisted, draft.paragraphs];
}

function draftEditorText(draft: IeltsEssayDraft): string {
  return draft.paragraphs.join("\n\n").replace(/\r\n?/gu, "\n");
}

function writingTextKey(paragraphs: readonly string[]): string {
  return normalizeAssistedTextKey(paragraphs.join("\n"));
}

function collectAssistedWritingKeys(
  draft: IeltsEssayDraft,
  receipt: IeltsRubricReceipt,
): string[] {
  const keys = new Set<string>();
  if (draft.assisted) {
    const key = writingTextKey(draft.paragraphs);
    if (key) keys.add(key);
  }
  if (receipt.sourceDraft?.assisted) {
    const key = writingTextKey(receipt.sourceDraft.paragraphs);
    if (key) keys.add(key);
  }
  return [...keys];
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return nested;
    const record = nested as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  });
}

function evaluationFingerprint(
  fixture: IeltsWorkbenchFixture,
  draft: IeltsEssayDraft,
  receipt: IeltsRubricReceipt,
  report: IeltsCrossDraftTransferReport,
): string {
  return stableSerialize([
    fixture.promptId, fixture.promptTitleZh, fixture.promptStatementEn, fixture.promptTaskTypeLabel,
    fixture.targetWordCount, fixture.draft1, fixture.draft1Receipt, fixture.targets, draft, receipt, report,
  ]);
}

const PARAGRAPH_BREAK = /\n\s*\n+/u;

export function IeltsDraftCritiqueWorkbench({
  fixture: providedFixture,
  initialView = "draft2",
  initialDraft,
  demoFixtureMode = false,
  onRevisionEvaluated,
}: IeltsDraftCritiqueWorkbenchProps) {
  const hasExternalFixture = providedFixture !== undefined;
  const fixture = providedFixture ?? IELTS_WRITING_SPEAKING_FIXTURE;
  const isDemoPreview = demoFixtureMode === true;
  const hasPreloadedSubmission =
    isDemoPreview || (hasExternalFixture && countDraftWords(fixture.draft2.paragraphs) > 0);

  const attemptKey = JSON.stringify(
    hasPreloadedSubmission
      ? [
          isDemoPreview,
          hasExternalFixture,
          fixture.promptId,
          draftIdentity(fixture.draft1),
          fixture.draft1Receipt.receiptId,
          draftIdentity(fixture.draft2),
          fixture.draft2Receipt.receiptId,
        ]
      : [
          isDemoPreview,
          hasExternalFixture,
          fixture.promptId,
          draftIdentity(fixture.draft1),
          fixture.draft1Receipt.receiptId,
          initialDraft ?? "",
        ],
  );
  const tabsIdPrefix = useId();
  const tabRefs = useRef<Partial<Record<DraftViewMode, HTMLButtonElement | null>>>({});

  const [viewMode, setViewMode] = useState<DraftViewMode>(initialView);
  const [criterionFilter, setCriterionFilter] = useState<IeltsCriterion | "ALL">("ALL");
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);

  const authorityFingerprint = evaluationFingerprint(
    fixture,
    fixture.draft2,
    fixture.draft2Receipt,
    fixture.transferReport,
  );
  const authoritative = {
    attemptKey,
    authorityFingerprint,
    draft2: fixture.draft2,
    draft2Receipt: fixture.draft2Receipt,
    transferReport: fixture.transferReport,
  };
  const [evaluation, setEvaluation] = useState({
    ...authoritative,
    cachedFingerprint: hasPreloadedSubmission ? (authorityFingerprint as string | null) : null,
  });
  const { draft2, draft2Receipt, transferReport: savedReport } = evaluation;

  const authoritativeAssistedKeys = hasPreloadedSubmission
    ? collectAssistedWritingKeys(fixture.draft2, fixture.draft2Receipt)
    : [];
  const authoritativeDraft2Key = hasPreloadedSubmission
    ? writingTextKey(fixture.draft2.paragraphs)
    : "";
  const initiallyLatched =
    hasPreloadedSubmission &&
    (fixture.draft2.assisted ||
      Boolean(fixture.draft2Receipt.sourceDraft?.assisted) ||
      (authoritativeDraft2Key !== "" && authoritativeAssistedKeys.includes(authoritativeDraft2Key)));

  const [hasSubmitted, setHasSubmitted] = useState(hasPreloadedSubmission);
  const [hintsRevealed, setHintsRevealed] = useState(false);
  const [attemptAssistedLatched, setAttemptAssistedLatched] = useState(initiallyLatched);
  const [resetPastAuthorityFingerprint, setResetPastAuthorityFingerprint] = useState<string | null>(
    null,
  );
  const [composerOpen, setComposerOpen] = useState(!hasPreloadedSubmission);
  const [composerText, setComposerText] = useState(() =>
    hasPreloadedSubmission ? draftEditorText(fixture.draft2) : (initialDraft ?? ""),
  );
  const [composerAssisted, setComposerAssisted] = useState(() => initiallyLatched);
  const [composerNeedsText, setComposerNeedsText] = useState(false);
  const composerGuidanceId = `${tabsIdPrefix}-revision-guidance`;
  const [revisionCount, setRevisionCount] = useState(0);
  const [localAssistedTexts, setLocalAssistedTexts] = useState<readonly string[]>(
    () => authoritativeAssistedKeys,
  );

  if (evaluation.authorityFingerprint !== authorityFingerprint) {
    setEvaluation({ ...authoritative, cachedFingerprint: null });
    setComposerNeedsText(false);
    setSelectedSpanId(null);
    if (evaluation.attemptKey !== attemptKey) {
      const isOwnWriteBack =
        revisionCount > 0 &&
        hasExternalFixture &&
        (fixture.draft2.draftId === evaluation.draft2.draftId ||
          fixture.draft2Receipt.receiptId === evaluation.draft2Receipt.receiptId);
      const nextAssistedTexts = isOwnWriteBack
        ? [...new Set([...localAssistedTexts, ...authoritativeAssistedKeys])]
        : authoritativeAssistedKeys;
      const nextLatched = isOwnWriteBack
        ? attemptAssistedLatched || initiallyLatched
        : initiallyLatched;
      setLocalAssistedTexts(nextAssistedTexts);
      setAttemptAssistedLatched(nextLatched);
      setHasSubmitted(hasPreloadedSubmission);
      if (!isOwnWriteBack) {
        setHintsRevealed(false);
        setResetPastAuthorityFingerprint(null);
      }
      setComposerText(
        hasPreloadedSubmission ? draftEditorText(fixture.draft2) : (initialDraft ?? ""),
      );
      setComposerAssisted(
        nextLatched ||
          (authoritativeDraft2Key !== "" && nextAssistedTexts.includes(authoritativeDraft2Key)),
      );
      setViewMode(initialView);
      setCriterionFilter("ALL");
      setComposerOpen(!hasPreloadedSubmission);
      setRevisionCount(0);
    } else if (hasPreloadedSubmission && authorityFingerprint !== resetPastAuthorityFingerprint) {
      if (authoritativeAssistedKeys.some((key) => !localAssistedTexts.includes(key))) {
        const nextAssistedTexts = [...new Set([...localAssistedTexts, ...authoritativeAssistedKeys])];
        setLocalAssistedTexts(nextAssistedTexts);
      }
      if (fixture.draft2.assisted || Boolean(fixture.draft2Receipt.sourceDraft?.assisted)) {
        setAttemptAssistedLatched(true);
        setComposerAssisted(true);
      }
    }
  }

  const stickyAssistedTexts = new Set([
    ...localAssistedTexts,
    ...authoritativeAssistedKeys,
    ...(hasSubmitted ? collectAssistedWritingKeys(draft2, draft2Receipt) : []),
  ]);
  const draft2TextKey = hasSubmitted ? writingTextKey(draft2.paragraphs) : "";
  const draft2EffectivelyAssisted =
    attemptAssistedLatched ||
    (hasSubmitted && draft2.assisted) ||
    (draft2TextKey !== "" && stickyAssistedTexts.has(draft2TextKey));
  const composerParagraphs = composerText.split(PARAGRAPH_BREAK);
  const composerTextKey = writingTextKey(composerParagraphs);
  const isComposerMatchingAssistedText =
    composerTextKey !== "" && stickyAssistedTexts.has(composerTextKey);
  const isComposerStickyAssisted = attemptAssistedLatched || isComposerMatchingAssistedText;
  const effectiveComposerAssisted = composerAssisted || isComposerStickyAssisted;

  const draftSource = stableSerialize(getWritingDraftSource(draft2));
  const transferSource = stableSerialize(getWritingTransferSource(fixture.draft1, fixture.targets));
  const { transferReport, matchesSavedEvaluation } = useMemo(() => {
    const matchesReport =
      savedReport.fromDraftId === fixture.draft1.draftId &&
      savedReport.toDraftId === draft2.draftId &&
      stableSerialize(savedReport.sourceDraft) === draftSource &&
      stableSerialize(savedReport.transferSource) === transferSource;
    return {
      transferReport: matchesReport
        ? savedReport
        : analyzeCrossDraftTransfer({
            draft1: fixture.draft1,
            draft2,
            targets: fixture.targets,
            promptStatement: fixture.promptStatementEn,
          }),
      matchesSavedEvaluation:
        matchesReport &&
        stableSerialize(draft2Receipt.sourceDraft) === draftSource &&
        stableSerialize(draft2Receipt.transferSource) === transferSource,
    };
  }, [
    fixture.draft1,
    fixture.targets,
    fixture.promptStatementEn,
    draft2,
    draft2Receipt,
    savedReport,
    draftSource,
    transferSource,
  ]);
  const activeDraft = viewMode === "draft1" ? fixture.draft1 : draft2;
  const activeReceipt = viewMode === "draft1" ? fixture.draft1Receipt : draft2Receipt;
  const activeDraftAssisted = viewMode === "draft1" ? activeDraft.assisted : draft2EffectivelyAssisted;
  const canShowVerifiedReceipt =
    !isDemoPreview &&
    hasSubmitted &&
    activeReceipt.masteryQualified &&
    activeReceipt.countsTowardMastery &&
    !activeDraftAssisted &&
    activeReceipt.promptId === activeDraft.promptId &&
    activeReceipt.draftId === activeDraft.draftId &&
    activeReceipt.draftVersion === activeDraft.version &&
    (viewMode === "draft1"
      ? stableSerialize(activeReceipt.sourceDraft) === stableSerialize(getWritingDraftSource(activeDraft))
      : matchesSavedEvaluation && transferReport.summary.masteryQualified);
  const epistemicStatus =
    activeReceipt.epistemicStatus === "rubric_verified_evidence" && !canShowVerifiedReceipt
      ? "practice_feedback"
      : activeReceipt.epistemicStatus;
  const epistemicMeta = EPISTEMIC_BADGE_META[epistemicStatus];

  const activeWordCount = useMemo(() => {
    if (!hasSubmitted) {
      return viewMode === "draft1"
        ? countDraftWords(fixture.draft1.paragraphs)
        : countDraftWords(composerText.split(PARAGRAPH_BREAK));
    }
    return countDraftWords(activeDraft.paragraphs);
  }, [hasSubmitted, viewMode, fixture.draft1.paragraphs, composerText, activeDraft.paragraphs]);

  const visibleCriteria = useMemo(
    () =>
      criterionFilter === "ALL"
        ? IELTS_CRITERIA
        : IELTS_CRITERIA.filter((code) => code === criterionFilter),
    [criterionFilter],
  );

  const tabDomId = (mode: DraftViewMode) => `${tabsIdPrefix}-tab-${mode}`;
  const panelDomId = (mode: DraftViewMode) => `${tabsIdPrefix}-panel-${mode}`;

  function activateTab(mode: DraftViewMode, moveFocus = false) {
    setViewMode(mode);
    setSelectedSpanId(null);
    if (moveFocus) {
      tabRefs.current[mode]?.focus();
    }
  }

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) {
    if (event.nativeEvent.isComposing) return;

    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % VIEW_TABS.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + VIEW_TABS.length) % VIEW_TABS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = VIEW_TABS.length - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      const targetTab = VIEW_TABS[nextIndex];
      if (targetTab) {
        activateTab(targetTab.id, true);
      }
    }
  }

  function handleRevealScaffold() {
    setHintsRevealed(true);
    setAttemptAssistedLatched(true);
    setComposerAssisted(true);
  }

  function handleAnalyzeRevision() {
    const paragraphs = composerText.split(PARAGRAPH_BREAK);
    const nextTextKey = writingTextKey(paragraphs);
    const nextAssisted =
      isDemoPreview ||
      composerAssisted ||
      attemptAssistedLatched ||
      (nextTextKey !== "" && stickyAssistedTexts.has(nextTextKey));
    const baseDraft: IeltsEssayDraft = hasSubmitted
      ? draft2
      : {
          ...fixture.draft2,
          version: Math.max(2, fixture.draft1.version + 1),
          basedOnVersion: fixture.draft1.version,
          paragraphs: [],
          assisted: false,
          timeSpentSeconds: 0,
        };
    const composerDraft = { ...baseDraft, paragraphs, assisted: nextAssisted };
    const fingerprint = evaluationFingerprint(
      fixture,
      composerDraft,
      draft2Receipt,
      transferReport,
    );
    if (hasSubmitted && matchesSavedEvaluation && fingerprint === evaluation.cachedFingerprint) {
      setComposerNeedsText(false);
      activateTab("draft2");
      return;
    }

    const nextCount = revisionCount + 1;
    const updatedDraft: IeltsEssayDraft = {
      ...composerDraft,
      draftId: `${fixture.draft2.draftId}-rev-${nextCount}`,
      version: Math.max(2, baseDraft.version),
      createdAt: new Date().toISOString(),
    };

    const evaluated = evaluateRevisedDraftDeterministically({
      baselineDraft: fixture.draft1,
      revisedDraft: updatedDraft,
      targets: fixture.targets,
      promptStatement: fixture.promptStatementEn,
      receiptId: `receipt-live-${nextCount}`,
    });

    if (!evaluated.ok) {
      setComposerNeedsText(true);
      return;
    }

    setComposerNeedsText(false);
    setHasSubmitted(true);
    setRevisionCount(nextCount);
    if (updatedDraft.assisted) {
      setAttemptAssistedLatched(true);
      setComposerAssisted(true);
      if (nextTextKey) {
        setLocalAssistedTexts((current) =>
          current.includes(nextTextKey) ? current : [...current, nextTextKey],
        );
      }
    }
    setEvaluation({
      ...authoritative,
      draft2: updatedDraft,
      draft2Receipt: evaluated.receipt,
      transferReport: evaluated.transferReport,
      cachedFingerprint: evaluationFingerprint(
        fixture,
        updatedDraft,
        evaluated.receipt,
        evaluated.transferReport,
      ),
    });
    activateTab("draft2");
    onRevisionEvaluated?.({
      revisedDraft: updatedDraft,
      receipt: evaluated.receipt,
      transferReport: evaluated.transferReport,
    });
  }

  function handleResetForFreshAttempt() {
    if (isDemoPreview) {
      setEvaluation({
        ...authoritative,
        cachedFingerprint:
          evaluation.cachedFingerprint === authorityFingerprint ? authorityFingerprint : null,
      });
      setComposerText(draftEditorText(fixture.draft2));
      setComposerAssisted(fixture.draft2.assisted);
      setAttemptAssistedLatched(fixture.draft2.assisted);
      setComposerNeedsText(false);
      setSelectedSpanId(null);
      return;
    }
    setHasSubmitted(false);
    setHintsRevealed(false);
    setAttemptAssistedLatched(false);
    setComposerAssisted(false);
    setComposerText("");
    setComposerNeedsText(false);
    setSelectedSpanId(null);
    setComposerOpen(true);
    setResetPastAuthorityFingerprint(authorityFingerprint);
    activateTab("draft2");
  }

  return (
    <section
      aria-label="雅思写作多稿精修工作台"
      className="mx-auto w-full max-w-6xl space-y-6 rounded-panel bg-bg p-4 text-text sm:p-6"
    >
      {/* Studio Desk Header */}
      <header className="rounded-panel border border-line bg-surface p-5 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-cap font-medium tracking-wide text-text-2">
              {fixture.promptTaskTypeLabel}
            </p>
            <h1 className="text-display font-semibold text-text">
              {fixture.promptTitleZh}
            </h1>
            <p className="rounded-tile border border-line bg-surface-2/70 px-4 py-3 font-reading text-read text-text">
              {fixture.promptStatementEn}
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-2">
            {hasSubmitted ? (
              <>
                <div className="flex items-baseline gap-2 rounded-tile border border-line bg-surface-2/60 px-4 py-2.5">
                  <span className="text-meta text-text-2">
                    {isDemoPreview ? "示例估分" : "综合估分"}
                  </span>
                  <span
                    data-overall-band
                    className="text-display font-semibold tabular-nums text-text"
                  >
                    Band {formatBandScore(activeReceipt.overallBand)}
                  </span>
                </div>

                <div
                  data-epistemic-badge={epistemicStatus}
                  data-demo-preview={isDemoPreview ? "true" : undefined}
                  className={`inline-flex items-center gap-2 rounded-pill border px-3 py-1 text-meta font-medium ${epistemicMeta.badgeClass}`}
                >
                  <span
                    aria-hidden="true"
                    className={`size-2 rounded-pill ${epistemicMeta.dotClass}`}
                  />
                  <span>
                    {isDemoPreview
                      ? "示例预览 · 仅作参考，不计入正式掌握度"
                      : epistemicMeta.writingLabel}
                  </span>
                </div>
              </>
            ) : (
              <div
                data-submission-state="unsubmitted"
                className="inline-flex items-center gap-2 rounded-pill border border-line-strong bg-surface-2 px-3 py-1.5 text-meta font-medium text-text-2"
              >
                <span aria-hidden="true" className="size-2 rounded-pill bg-text-3" />
                <span>
                  {attemptAssistedLatched
                    ? "已查看提示脚手架 · 本次为含辅助练习"
                    : "尚未提交 · 独立作答中"}
                </span>
              </div>
            )}
          </div>
        </div>

        <p className="mt-3 border-t border-line pt-3 text-meta text-text-2">
          {!hasSubmitted
            ? attemptAssistedLatched
              ? "你已展开提示与改写范例，本次作答已锁定为含辅助练习，不计入正式掌握度；如需开始新的独立作答，请点击「清空重做」。"
              : "请先在下方编辑区独立完成二稿改写并提交评估。提交后才会解锁四维量规证据、原文高亮定位与升级改写建议。"
            : isDemoPreview
              ? "当前为示例预览模式，仅展示范文与量规批改结构，不代表你已完成独立作答或获得正式掌握度。"
              : epistemicStatus === activeReceipt.epistemicStatus
                ? activeReceipt.epistemicReason
                : activeDraftAssisted
                  ? "本次作答包含提示或脚手架辅助，仅作练习诊断反馈，不计入正式掌握度。"
                  : transferReport.summary.disqualificationReason ?? "本轮迁移证据已更新，请重新分析改写。"}
        </p>
      </header>

      {/* Asymmetric Dual-Column Studio Desk Layout */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.95fr)]">
        {/* Left Column: Multi-Draft Manuscript & Inline Revision */}
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-tile border border-line bg-surface px-4 py-3 shadow-card">
            <div
              role="tablist"
              aria-label="草稿视图切换"
              className="inline-flex items-center gap-1 rounded-pill bg-surface-2 p-1"
            >
              {VIEW_TABS.map((tab, index) => {
                const selected = viewMode === tab.id;
                return (
                  <button
                    key={tab.id}
                    ref={(node) => {
                      tabRefs.current[tab.id] = node;
                    }}
                    id={tabDomId(tab.id)}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={panelDomId(tab.id)}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => activateTab(tab.id)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                    className={`rounded-pill px-3.5 py-1.5 text-meta font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus-ring ${
                      selected
                        ? "bg-surface text-text shadow-card"
                        : "text-text-2 hover:text-text"
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-meta tabular-nums">
              <span
                data-word-count
                className={`rounded-pill border px-3 py-1 ${
                  activeWordCount >= fixture.targetWordCount
                    ? "border-accent/30 bg-accent-soft text-accent"
                    : "border-warn/30 bg-warn-soft text-warn"
                }`}
              >
                {activeWordCount} 词 · 目标 {fixture.targetWordCount}+
              </span>
              {hasSubmitted && (
                <span
                  data-time-box
                  className="rounded-pill border border-line bg-surface-2 px-3 py-1 text-text-2"
                >
                  计时 {formatTimeBox(activeDraft.timeSpentSeconds, activeDraft.timeBoxSeconds)}
                </span>
              )}
            </div>
          </div>

          {/* Criterion Highlight Filter Bar (single-draft mode) */}
          {viewMode !== "compare" && (
            <div
              role="group"
              aria-label="按评分维度筛选句段标注"
              className="flex flex-wrap items-center gap-1.5"
            >
              <button
                type="button"
                aria-pressed={criterionFilter === "ALL"}
                onClick={() => setCriterionFilter("ALL")}
                className={`rounded-pill border px-3 py-1 text-meta transition-colors ${
                  criterionFilter === "ALL"
                    ? "border-ink bg-ink text-on-ink font-medium"
                    : "border-line bg-surface text-text-2 hover:text-text"
                }`}
              >
                全部维度
              </button>
              {IELTS_CRITERIA.map((code) => {
                const style = CRITERION_STYLES[code];
                const active = criterionFilter === code;
                return (
                  <button
                    key={code}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      setCriterionFilter((prev) => (prev === code ? "ALL" : code))
                    }
                    className={`rounded-pill border px-3 py-1 text-meta transition-colors ${
                      active ? style.activeChipClass : style.chipClass
                    }`}
                  >
                    {code} · {style.zhLabel}
                  </button>
                );
              })}
            </div>
          )}

          {/* Manuscript Paper Sheets & Comparison Tabpanels (all 3 mounted for valid aria-controls) */}
          {(["draft1", "draft2"] as const).map((sheetMode) => {
            const isActiveSheet = viewMode === sheetMode;

            if (!hasSubmitted && sheetMode === "draft2") {
              return (
                <article
                  key={sheetMode}
                  id={panelDomId(sheetMode)}
                  role="tabpanel"
                  aria-labelledby={tabDomId(sheetMode)}
                  hidden={!isActiveSheet}
                  tabIndex={isActiveSheet ? 0 : -1}
                  className="rounded-panel border border-dashed border-line-strong bg-surface p-6 shadow-card focus-visible:outline-2 focus-visible:outline-focus-ring"
                >
                  <p className="text-ui font-medium text-text">待独立提交二稿</p>
                  <p className="mt-1.5 text-meta text-text-2">
                    当前不预置完成版范文或升级改写示例。请在下方编辑区撰写你的二稿并点击「提交并评估改写」，系统将即时生成四维量规定位与跨稿迁移清单。
                  </p>
                </article>
              );
            }

            const sheetDraft = sheetMode === "draft1" ? fixture.draft1 : draft2;
            const sheetReceipt =
              sheetMode === "draft1" ? fixture.draft1Receipt : draft2Receipt;
            const sheetSpans = hasSubmitted ? collectAllSpans(sheetReceipt) : [];

            return (
              <article
                key={sheetMode}
                id={panelDomId(sheetMode)}
                role="tabpanel"
                aria-labelledby={tabDomId(sheetMode)}
                hidden={!isActiveSheet}
                tabIndex={isActiveSheet ? 0 : -1}
                className="rounded-panel border border-line bg-surface p-6 shadow-card focus-visible:outline-2 focus-visible:outline-focus-ring"
              >
                <div className="mb-4 flex items-center justify-between border-b border-line pb-3">
                  <div className="flex items-center gap-2">
                    <span className="rounded-pill bg-surface-2 px-2.5 py-0.5 text-cap font-medium text-text">
                      {sheetDraft.label}
                    </span>
                    <span className="text-meta text-text-2">
                      {(sheetMode === "draft1" ? sheetDraft.assisted : draft2EffectivelyAssisted)
                        ? "含提示辅助"
                        : "独立作答"}
                    </span>
                  </div>
                  <span className="text-cap text-text-3">
                    {hasSubmitted ? "点击高亮句段可联动右侧诊断" : "一稿底稿参考（不含范文改写）"}
                  </span>
                </div>

                <div className="space-y-5 font-reading text-read leading-7 text-text">
                  {sheetDraft.paragraphs.map((paragraph, pIndex) => {
                    const paragraphSpans = sheetSpans.filter(
                      (span) => span.paragraphIndex === pIndex,
                    );
                    const segments = segmentParagraphWithSpans(
                      paragraph,
                      paragraphSpans,
                      criterionFilter,
                    );

                    return (
                      <div key={`${sheetDraft.draftId}-p-${pIndex}`} className="flex gap-3">
                        <span className="mt-1 shrink-0 font-mono text-cap tabular-nums text-text-3">
                          P{pIndex + 1}
                        </span>
                        <p className="min-w-0 flex-1">
                          {segments.map((segment, segIdx) => {
                            if (segment.kind === "text") {
                              return <span key={segIdx}>{segment.text}</span>;
                            }
                            const style = CRITERION_STYLES[segment.span.criterion];
                            const isSelected = selectedSpanId === segment.span.id;
                            return (
                              <button
                                key={segment.span.id}
                                type="button"
                                data-span-id={segment.span.id}
                                data-criterion={segment.span.criterion}
                                aria-pressed={isSelected}
                                onClick={() =>
                                  setSelectedSpanId((prev) =>
                                    prev === segment.span.id ? null : segment.span.id,
                                  )
                                }
                                className={`inline cursor-pointer rounded-sm px-0.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-focus-ring ${
                                  isSelected ? style.activeMarkClass : style.markClass
                                }`}
                              >
                                {segment.text}
                                <sup className="ml-0.5 font-sans text-micro font-semibold">
                                  {segment.span.criterion}
                                </sup>
                              </button>
                            );
                          })}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </article>
            );
          })}

          <section
            id={panelDomId("compare")}
            role="tabpanel"
            aria-labelledby={tabDomId("compare")}
            hidden={viewMode !== "compare"}
            tabIndex={viewMode === "compare" ? 0 : -1}
            className="space-y-3 rounded-panel border border-line bg-surface p-5 shadow-card focus-visible:outline-2 focus-visible:outline-focus-ring"
          >
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h2 className="text-ui-lg font-semibold text-text">逐段改写对照</h2>
              <span className="text-meta text-text-2">
                {hasSubmitted
                  ? `共 ${transferReport.paragraphDiffs.length} 段 · 一稿 → 二稿`
                  : "提交二稿后生成逐段对照"}
              </span>
            </div>

            {hasSubmitted ? (
              <div className="space-y-4">
                {transferReport.paragraphDiffs.map((diff) => (
                  <div
                    key={diff.paragraphIndex}
                    className="rounded-tile border border-line bg-bg p-4"
                  >
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-cap font-semibold text-text-2">
                          P{diff.paragraphIndex + 1}
                        </span>
                        <span className="rounded-pill border border-line bg-surface px-2.5 py-0.5 text-cap text-text-2">
                          {DIFF_STATUS_LABEL[diff.status]}
                        </span>
                      </div>
                      <span className="text-cap tabular-nums text-text-2">
                        词数变化：{diff.wordDelta >= 0 ? `+${diff.wordDelta}` : diff.wordDelta} 词
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div className="rounded-ctl border border-line bg-surface p-3">
                        <p className="mb-1.5 text-cap font-medium text-text-3">一稿原文</p>
                        <p className="font-reading text-ui-lg leading-6 text-text-2">
                          {diff.draft1Text || "（该段在一稿中为空）"}
                        </p>
                      </div>
                      <div className="rounded-ctl border border-accent/25 bg-surface p-3">
                        <p className="mb-1.5 text-cap font-medium text-accent">二稿改写</p>
                        <p className="font-reading text-ui-lg leading-6 text-text">
                          {diff.draft2Text || "（该段在二稿中已合并或删去）"}
                        </p>
                      </div>
                    </div>

                    {diff.addedTerms.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                        <span className="text-cap text-text-3">新增核心词：</span>
                        {diff.addedTerms.slice(0, 6).map((term) => (
                          <span
                            key={term}
                            className="rounded-pill border border-accent/25 bg-accent-soft px-2 py-0.5 text-cap text-accent"
                          >
                            {term}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-meta text-text-2">
                完成并提交你的二稿后，此处将展示一稿与二稿的逐段改写差异与新增核心词。
              </p>
            )}
          </section>

          {/* Inline Revision Composer */}
          <section
            aria-label="二稿在线精修编辑区"
            className="rounded-panel border border-line bg-surface p-5 shadow-card"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-ui-lg font-semibold text-text">在线精修二稿</h2>
                <p className="text-meta text-text-2">
                  直接撰写或修改段落后提交评估，系统会对照一稿检查目标搭配与句式是否真正迁移。
                </p>
              </div>
              <button
                type="button"
                aria-expanded={composerOpen}
                onClick={() => setComposerOpen((prev) => !prev)}
                className="rounded-pill border border-line-strong bg-surface px-3.5 py-1.5 text-meta font-medium text-text hover:bg-surface-2"
              >
                {composerOpen ? "收起编辑区" : "打开改写编辑区"}
              </button>
            </div>

            {composerOpen && (
              <div className="mt-4 space-y-3 border-t border-line pt-4">
                <label className="block space-y-1.5">
                  <span className="text-meta font-medium text-text-2">
                    二稿段落内容（空行分段）
                  </span>
                  <textarea
                    aria-label="二稿改写编辑区"
                    aria-invalid={composerNeedsText || undefined}
                    aria-describedby={composerNeedsText ? composerGuidanceId : undefined}
                    rows={8}
                    value={composerText}
                    placeholder={`在此独立撰写你的二稿改写（空行分段，建议 ${fixture.targetWordCount}+ 词）...`}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      const nextKey = writingTextKey(nextValue.split(PARAGRAPH_BREAK));
                      if (nextKey !== "" && stickyAssistedTexts.has(nextKey)) {
                        setAttemptAssistedLatched(true);
                        setComposerAssisted(true);
                      }
                      setComposerText(nextValue);
                      setComposerNeedsText(false);
                    }}
                    className="block w-full rounded-ctl border border-line-strong bg-bg px-3.5 py-2.5 font-reading text-read leading-6 text-text placeholder:text-text-3 focus:border-text focus:outline-none"
                  />
                </label>
                {composerNeedsText && (
                  <p id={composerGuidanceId} role="alert" className="text-meta text-danger">
                    请先写几句英文再重新分析。只有标点或没有英文单词的内容无法分析。
                  </p>
                )}

                {!isDemoPreview && !hasSubmitted && (
                  <div className="space-y-2 rounded-ctl border border-line bg-surface-2/60 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-cap text-text-2">
                        需要脚手架思路或升级改写示例？展开后本次尝试将不可逆地标记为含辅助练习。
                      </span>
                      <button
                        type="button"
                        data-reveal-scaffold
                        disabled={hintsRevealed}
                        onClick={handleRevealScaffold}
                        className="rounded-pill border border-line-strong bg-surface px-3 py-1 text-cap font-medium text-text hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {hintsRevealed
                          ? "已展开提示 / 改写范例（本次已标记为含辅助）"
                          : "查看提示 / 改写范例（将标记本次作答为含辅助）"}
                      </button>
                    </div>

                    {hintsRevealed && (
                      <div
                        data-writing-scaffold="true"
                        className="space-y-2 border-t border-line pt-2.5 text-meta"
                      >
                        <p className="text-cap font-medium text-warn">
                          提示脚手架已展开 · 本次作答已锁定为含辅助练习，不计入正式掌握度
                        </p>
                        <ul className="space-y-1.5 text-text-2">
                          {fixture.targets.map((target) => (
                            <li key={target.id}>
                              <strong className="font-medium text-text">{target.label}：</strong>
                              {target.guidance}
                            </li>
                          ))}
                        </ul>
                        <div className="space-y-1.5 border-t border-line pt-2">
                          <p className="text-cap font-medium text-text-3">参考改写句段</p>
                          {IELTS_CRITERIA.flatMap((code) =>
                            fixture.draft1Receipt.criteria[code].evidenceSpans.map((span) => (
                              <p
                                key={span.id}
                                data-exemplar-rewrite={span.id}
                                className="font-reading text-meta text-text"
                              >
                                <span className="mr-1.5 font-sans text-cap font-semibold text-accent">
                                  {code}
                                </span>
                                {span.upgradeRewrite}
                              </p>
                            )),
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label
                    className={`inline-flex items-center gap-2 text-meta text-text-2 ${
                      isComposerStickyAssisted ? "cursor-not-allowed" : "cursor-pointer"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={effectiveComposerAssisted}
                      disabled={isComposerStickyAssisted}
                      onChange={(event) => {
                        if (isComposerStickyAssisted) return;
                        setComposerAssisted(event.target.checked);
                      }}
                      className="size-4 accent-ink disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <span>
                      {isComposerStickyAssisted
                        ? "本次作答已含提示辅助，已锁定为练习诊断（点击「清空重做」可开始新的独立作答）"
                        : "本次改写参考了范文或提示（勾选后仅作练习诊断，不计入正式掌握度）"}
                    </span>
                  </label>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-reset-attempt
                      onClick={handleResetForFreshAttempt}
                      className="rounded-pill px-3 py-1.5 text-meta text-text-2 hover:bg-surface-2 hover:text-text"
                    >
                      {isDemoPreview ? "恢复示例二稿" : "清空重做（开始独立作答）"}
                    </button>
                    <button
                      type="button"
                      data-submit-writing
                      onClick={handleAnalyzeRevision}
                      className="rounded-pill bg-ink px-4 py-1.5 text-meta font-medium text-on-ink hover:bg-ink/90"
                    >
                      {hasSubmitted ? "重新分析改写" : "提交并评估改写"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Right Column: 4-Dimension Official Rubric Evidence & Cross-Draft Transfer Checklist */}
        <aside className="space-y-4">
          {/* 4-Dimension Quick Band Strip */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
            {IELTS_CRITERIA.map((code) => {
              const assessment = activeReceipt.criteria[code];
              const style = CRITERION_STYLES[code];
              const isSelected = criterionFilter === code;
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() =>
                    setCriterionFilter((prev) => (prev === code ? "ALL" : code))
                  }
                  className={`flex items-center justify-between rounded-tile border px-3.5 py-2.5 text-left transition-colors ${
                    isSelected
                      ? style.activeChipClass
                      : "border-line bg-surface hover:border-line-strong"
                  }`}
                >
                  <div>
                    <p className="text-cap font-semibold text-text">{code}</p>
                    <p className="text-cap text-text-2">{style.zhLabel}</p>
                  </div>
                  <span className="text-title font-semibold tabular-nums text-text">
                    {hasSubmitted ? formatBandScore(assessment.band) : "—"}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Memorized Template Warning Banner */}
          {hasSubmitted && activeReceipt.memorizedTemplateFlags.length > 0 && (
            <section
              role="alert"
              aria-label="模板套话提醒"
              className="space-y-2 rounded-tile border border-danger/30 bg-danger-soft p-4 text-danger"
            >
              <p className="text-ui font-semibold">
                检测到 {activeReceipt.memorizedTemplateFlags.length} 处高频模板套话
              </p>
              <ul className="space-y-1.5 text-meta">
                {activeReceipt.memorizedTemplateFlags.map((hit, index) => (
                  <li key={`${hit.phrase}-${index}`}>
                    <span className="font-mono font-semibold">
                      P{hit.paragraphIndex + 1} · &ldquo;{hit.phrase}&rdquo;
                    </span>
                    ：{hit.advice}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* 4-Dimension Structured Evidence Cards */}
          <section aria-label="四维量规证据卡片" className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-ui-lg font-semibold text-text">
                四维官方量规依据（TR / CC / LR / GRA）
              </h2>
              <span className="text-cap text-text-3">
                {hasSubmitted ? "每项均附原文定位" : "提交后生成原文定位与改写建议"}
              </span>
            </div>

            {visibleCriteria.map((code) => {
              const assessment = activeReceipt.criteria[code];
              const style = CRITERION_STYLES[code];
              return (
                <article
                  key={code}
                  data-criterion-card={code}
                  className="overflow-hidden rounded-tile border border-line bg-surface shadow-card"
                >
                  <div className={`h-1 w-full ${style.accentBarClass}`} />
                  <div className="space-y-3 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-pill border px-2 py-0.5 text-cap font-semibold ${style.badgeClass}`}
                        >
                          {code}
                        </span>
                        <h3 className="text-ui font-semibold text-text">
                          {style.zhLabel}
                          <span className="ml-1.5 font-normal text-text-3">
                            {style.officialName}
                          </span>
                        </h3>
                      </div>
                      {hasSubmitted && (
                        <span className="text-ui-lg font-semibold tabular-nums text-text">
                          Band {formatBandScore(assessment.band)}
                        </span>
                      )}
                    </div>

                    {hasSubmitted ? (
                      <>
                        <p className="text-meta text-text-2">{assessment.summary}</p>

                        <div className="space-y-2.5">
                          {assessment.evidenceSpans.map((span) => {
                            const isFocused = selectedSpanId === span.id;
                            return (
                              <div
                                key={span.id}
                                className={`rounded-ctl border p-3 transition-colors ${
                                  isFocused
                                    ? "border-text bg-surface-2"
                                    : "border-line bg-bg"
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (viewMode === "compare") setViewMode("draft2");
                                    setSelectedSpanId(span.id);
                                  }}
                                  className="w-full text-left"
                                >
                                  <p className="mb-1 text-cap font-medium text-text-3">
                                    原文引证 · P{span.paragraphIndex + 1}
                                  </p>
                                  <blockquote className="border-l-2 border-line-strong pl-2.5 font-reading text-ui text-text">
                                    &ldquo;{span.excerpt}&rdquo;
                                  </blockquote>
                                </button>
                                <p className="mt-2 text-meta text-text-2">
                                  <strong className="font-medium text-text">诊断：</strong>
                                  {span.diagnosis}
                                </p>
                                <p
                                  data-exemplar-rewrite={span.id}
                                  className="mt-1 text-meta text-text-2"
                                >
                                  <strong className="font-medium text-accent">升级改写：</strong>
                                  <span className="font-reading text-text">
                                    {span.upgradeRewrite}
                                  </span>
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    ) : (
                      <p className="text-meta text-text-2">
                        {IELTS_CRITERION_META[code].focusSummary}
                      </p>
                    )}
                  </div>
                </article>
              );
            })}
          </section>

          {/* Cross-Draft Transfer Checklist */}
          <section
            aria-label="跨草稿迁移对照清单"
            className="space-y-3 rounded-panel border border-line bg-surface p-4 shadow-card"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
              <div>
                <h2 className="text-ui-lg font-semibold text-text">跨草稿迁移对照清单</h2>
                <p className="text-cap text-text-2">
                  追踪一稿 → 二稿的搭配、句式、衔接与反方深度落地情况
                </p>
              </div>
              <span
                data-transfer-summary
                className="rounded-pill border border-line bg-surface-2 px-3 py-1 text-meta font-medium tabular-nums text-text"
              >
                已迁移 {hasSubmitted ? transferReport.summary.transferredCount : 0} /{" "}
                {hasSubmitted ? transferReport.summary.totalTargets : fixture.targets.length}
              </span>
            </div>

            {hasSubmitted ? (
              <ul className="space-y-2.5">
                {transferReport.items.map((item) => {
                  const statusMeta = TRANSFER_STATUS_META[item.status];
                  const critStyle = CRITERION_STYLES[item.criterion];
                  return (
                    <li
                      key={item.targetId}
                      data-transfer-item={item.targetId}
                      data-transfer-status={item.status}
                      className="rounded-tile border border-line bg-bg p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`rounded-pill border px-2 py-0.5 text-micro font-semibold ${critStyle.badgeClass}`}
                          >
                            {item.criterion}
                          </span>
                          <span className="rounded-pill border border-line bg-surface px-2 py-0.5 text-micro text-text-2">
                            {UPGRADE_CATEGORY_LABELS[item.category]}
                          </span>
                          <span className="text-ui font-medium text-text">{item.label}</span>
                        </div>

                        <span
                          className={`rounded-pill border px-2.5 py-0.5 text-cap font-medium ${statusMeta.badgeClass}`}
                        >
                          {statusMeta.label}
                        </span>
                      </div>

                      <p className="mt-1.5 text-meta text-text-2">{item.explanation}</p>

                      {item.revisedMatched.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {item.revisedMatched.map((phrase) => (
                            <span
                              key={phrase}
                              className="rounded-pill border border-accent/25 bg-accent-soft px-2 py-0.5 font-reading text-cap text-accent"
                            >
                              {phrase}
                            </span>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <ul className="space-y-2.5">
                {fixture.targets.map((target) => {
                  const statusMeta = TRANSFER_STATUS_META.pending;
                  const critStyle = CRITERION_STYLES[target.criterion];
                  return (
                    <li
                      key={target.id}
                      data-transfer-item={target.id}
                      data-transfer-status="pending"
                      className="rounded-tile border border-line bg-bg p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`rounded-pill border px-2 py-0.5 text-micro font-semibold ${critStyle.badgeClass}`}
                          >
                            {target.criterion}
                          </span>
                          <span className="rounded-pill border border-line bg-surface px-2 py-0.5 text-micro text-text-2">
                            {UPGRADE_CATEGORY_LABELS[target.category]}
                          </span>
                          <span className="text-ui font-medium text-text">{target.label}</span>
                        </div>
                        <span
                          className={`rounded-pill border px-2.5 py-0.5 text-cap font-medium ${statusMeta.badgeClass}`}
                        >
                          {statusMeta.label}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}
