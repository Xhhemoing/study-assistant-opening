"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  IELTS_CRITERIA,
  countDraftWords,
  evaluateRevisedDraftDeterministically,
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
  segmentParagraphWithSpans,
  type DraftViewMode,
} from "./workbench-model";

export type IeltsDraftCritiqueWorkbenchProps = {
  readonly fixture?: IeltsWorkbenchFixture;
  readonly initialView?: DraftViewMode;
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

export function IeltsDraftCritiqueWorkbench({
  fixture = IELTS_WRITING_SPEAKING_FIXTURE,
  initialView = "draft2",
  onRevisionEvaluated,
}: IeltsDraftCritiqueWorkbenchProps) {
  const tabsIdPrefix = useId();
  const tabRefs = useRef<Partial<Record<DraftViewMode, HTMLButtonElement | null>>>({});

  const [viewMode, setViewMode] = useState<DraftViewMode>(initialView);
  const [criterionFilter, setCriterionFilter] = useState<IeltsCriterion | "ALL">("ALL");
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);

  const [draft2, setDraft2] = useState<IeltsEssayDraft>(fixture.draft2);
  const [draft2Receipt, setDraft2Receipt] = useState<IeltsRubricReceipt>(
    fixture.draft2Receipt,
  );
  const [transferReport, setTransferReport] = useState<IeltsCrossDraftTransferReport>(
    fixture.transferReport,
  );

  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState(() =>
    fixture.draft2.paragraphs.join("\n\n"),
  );
  const [composerAssisted, setComposerAssisted] = useState(fixture.draft2.assisted);
  const [revisionCount, setRevisionCount] = useState(0);

  const activeDraft = viewMode === "draft1" ? fixture.draft1 : draft2;
  const activeReceipt = viewMode === "draft1" ? fixture.draft1Receipt : draft2Receipt;
  const epistemicMeta = EPISTEMIC_BADGE_META[activeReceipt.epistemicStatus];

  const activeSpans = useMemo(() => collectAllSpans(activeReceipt), [activeReceipt]);
  const activeWordCount = useMemo(
    () => countDraftWords(activeDraft.paragraphs),
    [activeDraft.paragraphs],
  );

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

  function handleAnalyzeRevision() {
    const paragraphs = composerText
      .split(/\n\s*\n+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (paragraphs.length === 0) return;

    const nextCount = revisionCount + 1;
    const updatedDraft: IeltsEssayDraft = {
      ...draft2,
      draftId: `${fixture.draft2.draftId}-rev-${nextCount}`,
      version: Math.max(2, draft2.version),
      assisted: composerAssisted,
      paragraphs,
      createdAt: new Date().toISOString(),
    };

    const evaluated = evaluateRevisedDraftDeterministically({
      baselineDraft: fixture.draft1,
      revisedDraft: updatedDraft,
      targets: fixture.targets,
      receiptId: `receipt-live-${nextCount}`,
    });

    setRevisionCount(nextCount);
    setDraft2(updatedDraft);
    setDraft2Receipt(evaluated.receipt);
    setTransferReport(evaluated.transferReport);
    setViewMode("draft2");
    setSelectedSpanId(null);
    onRevisionEvaluated?.({
      revisedDraft: updatedDraft,
      receipt: evaluated.receipt,
      transferReport: evaluated.transferReport,
    });
  }

  function handleResetRevision() {
    setDraft2(fixture.draft2);
    setDraft2Receipt(fixture.draft2Receipt);
    setTransferReport(fixture.transferReport);
    setComposerText(fixture.draft2.paragraphs.join("\n\n"));
    setComposerAssisted(fixture.draft2.assisted);
    setSelectedSpanId(null);
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
            <div className="flex items-baseline gap-2 rounded-tile border border-line bg-surface-2/60 px-4 py-2.5">
              <span className="text-meta text-text-2">综合估分</span>
              <span
                data-overall-band
                className="text-display font-semibold tabular-nums text-text"
              >
                Band {formatBandScore(activeReceipt.overallBand)}
              </span>
            </div>

            <div
              data-epistemic-badge={activeReceipt.epistemicStatus}
              className={`inline-flex items-center gap-2 rounded-pill border px-3 py-1 text-meta font-medium ${epistemicMeta.badgeClass}`}
            >
              <span
                aria-hidden="true"
                className={`size-2 rounded-pill ${epistemicMeta.dotClass}`}
              />
              <span>{epistemicMeta.writingLabel}</span>
            </div>
          </div>
        </div>

        <p className="mt-3 border-t border-line pt-3 text-meta text-text-2">
          {activeReceipt.epistemicReason}
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
              <span
                data-time-box
                className="rounded-pill border border-line bg-surface-2 px-3 py-1 text-text-2"
              >
                计时 {formatTimeBox(activeDraft.timeSpentSeconds, activeDraft.timeBoxSeconds)}
              </span>
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

          {/* Manuscript Paper Sheet / Comparison Tabpanel */}
          {viewMode !== "compare" ? (
            <article
              id={panelDomId(viewMode)}
              role="tabpanel"
              aria-labelledby={tabDomId(viewMode)}
              tabIndex={0}
              className="rounded-panel border border-line bg-surface p-6 shadow-card focus-visible:outline-2 focus-visible:outline-focus-ring"
            >
              <div className="mb-4 flex items-center justify-between border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <span className="rounded-pill bg-surface-2 px-2.5 py-0.5 text-cap font-medium text-text">
                    {activeDraft.label}
                  </span>
                  <span className="text-meta text-text-2">
                    {activeDraft.assisted ? "含提示辅助" : "独立作答"}
                  </span>
                </div>
                <span className="text-cap text-text-3">点击高亮句段可联动右侧诊断</span>
              </div>

              <div className="space-y-5 font-reading text-read leading-7 text-text">
                {activeDraft.paragraphs.map((paragraph, pIndex) => {
                  const paragraphSpans = activeSpans.filter(
                    (span) => span.paragraphIndex === pIndex,
                  );
                  const segments = segmentParagraphWithSpans(
                    paragraph,
                    paragraphSpans,
                    criterionFilter,
                  );

                  return (
                    <div key={`${activeDraft.draftId}-p-${pIndex}`} className="flex gap-3">
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
          ) : (
            <section
              id={panelDomId("compare")}
              role="tabpanel"
              aria-labelledby={tabDomId("compare")}
              tabIndex={0}
              className="space-y-3 rounded-panel border border-line bg-surface p-5 shadow-card focus-visible:outline-2 focus-visible:outline-focus-ring"
            >
              <div className="flex items-center justify-between border-b border-line pb-3">
                <h2 className="text-ui-lg font-semibold text-text">逐段改写对照</h2>
                <span className="text-meta text-text-2">
                  共 {transferReport.paragraphDiffs.length} 段 · 一稿 → 二稿
                </span>
              </div>

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
            </section>
          )}

          {/* Inline Revision Composer */}
          <section
            aria-label="二稿在线精修编辑区"
            className="rounded-panel border border-line bg-surface p-5 shadow-card"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-ui-lg font-semibold text-text">在线精修二稿</h2>
                <p className="text-meta text-text-2">
                  直接修改段落后重新评估，系统会实时对照一稿检查目标搭配与句式是否真正迁移。
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
                    rows={8}
                    value={composerText}
                    onChange={(event) => setComposerText(event.target.value)}
                    className="block w-full rounded-ctl border border-line-strong bg-bg px-3.5 py-2.5 font-reading text-read leading-6 text-text focus:border-text focus:outline-none"
                  />
                </label>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="inline-flex cursor-pointer items-center gap-2 text-meta text-text-2">
                    <input
                      type="checkbox"
                      checked={composerAssisted}
                      onChange={(event) => setComposerAssisted(event.target.checked)}
                      className="size-4 accent-ink"
                    />
                    <span>本次改写参考了范文或提示（勾选后仅作练习诊断，不计入正式掌握度）</span>
                  </label>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleResetRevision}
                      className="rounded-pill px-3 py-1.5 text-meta text-text-2 hover:bg-surface-2 hover:text-text"
                    >
                      恢复示例二稿
                    </button>
                    <button
                      type="button"
                      onClick={handleAnalyzeRevision}
                      className="rounded-pill bg-ink px-4 py-1.5 text-meta font-medium text-on-ink hover:bg-ink/90"
                    >
                      重新分析改写
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
                    {formatBandScore(assessment.band)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Memorized Template Warning Banner */}
          {activeReceipt.memorizedTemplateFlags.length > 0 && (
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
              <span className="text-cap text-text-3">每项均附原文定位</span>
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
                      <span className="text-ui-lg font-semibold tabular-nums text-text">
                        Band {formatBandScore(assessment.band)}
                      </span>
                    </div>

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
                            <p className="mt-1 text-meta text-text-2">
                              <strong className="font-medium text-accent">升级改写：</strong>
                              <span className="font-reading text-text">
                                {span.upgradeRewrite}
                              </span>
                            </p>
                          </div>
                        );
                      })}
                    </div>
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
                已迁移 {transferReport.summary.transferredCount} /{" "}
                {transferReport.summary.totalTargets}
              </span>
            </div>

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
          </section>
        </aside>
      </div>
    </section>
  );
}
