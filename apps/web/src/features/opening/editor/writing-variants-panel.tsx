"use client";

import type {
  WritingAssistanceKind,
  WritingDimension,
  WritingWorkspaceResponse,
  WritingWorkspaceView,
} from "@aistudy/contracts";
import { Check, GitBranch, RefreshCw, Sparkles, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { ui } from "../design/ui";
import { DEFAULT_LIBRARY_BASE_PATH, libraryNotePath, type LibraryBasePath } from "./library-paths";
import {
  createWritingWorkspaceApi,
  WritingWorkspaceApiError,
  type WritingWorkspaceApi,
} from "./writing-workspace-api";

export type WritingEditorBlockOption = {
  id: string;
  text: string;
};

type Props = {
  documentId: string;
  currentRevisionNumber: number;
  blocks: WritingEditorBlockOption[];
  basePath?: LibraryBasePath;
  focusBlockId?: string | null;
  activityId?: string | null;
  hasUnsavedEdits?: boolean;
  api?: WritingWorkspaceApi;
  initialResponse?: WritingWorkspaceResponse | null;
  onWorkspaceLoaded?: (response: WritingWorkspaceResponse) => void;
  onDocumentUpdated?: (newRevisionNumber: number) => void;
};

const DIMENSION_LABELS: Record<WritingDimension, string> = {
  argument: "论点",
  language: "语言",
  structure: "结构",
  evidence: "论据",
};

const KIND_LABELS: Record<WritingAssistanceKind, string> = {
  feedback: "写作批注",
  polish_suggestion: "句子润色",
};

const PRESET_VARIANTS = ["初稿", "A 稿", "B 稿"] as const;

function variantHref(
  basePath: LibraryBasePath,
  documentId: string,
  activityId: string | null,
  focusBlockId: string | null,
): string {
  const path = libraryNotePath(basePath, documentId);
  const params = new URLSearchParams();
  if (focusBlockId) params.set("block", focusBlockId);
  if (activityId) params.set("activity", activityId);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function blockPreview(block: WritingEditorBlockOption, index: number): string {
  const clean = block.text.trim();
  return clean ? `第 ${index + 1} 段 · ${clean.slice(0, 28)}` : `第 ${index + 1} 段（空白）`;
}

export function WritingVariantsPanel({
  documentId,
  currentRevisionNumber,
  blocks,
  basePath = DEFAULT_LIBRARY_BASE_PATH,
  focusBlockId = null,
  activityId = null,
  hasUnsavedEdits = false,
  api: apiProp,
  initialResponse = null,
  onWorkspaceLoaded,
  onDocumentUpdated,
}: Props) {
  const api = useMemo(() => apiProp ?? createWritingWorkspaceApi(), [apiProp]);
  const [state, setState] = useState<WritingWorkspaceResponse | null>(initialResponse);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const onWorkspaceLoadedRef = useRef(onWorkspaceLoaded);
  onWorkspaceLoadedRef.current = onWorkspaceLoaded;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  const [variantLabelInput, setVariantLabelInput] = useState("A 稿");
  const [selectedFocusBlockId, setSelectedFocusBlockId] = useState<string>(() => {
    if (initialResponse?.initialized) {
      return initialResponse.workspace.focusRestore.status === "exact"
        ? initialResponse.workspace.focusRestore.blockId
        : initialResponse.workspace.currentVariant.focusBlockId ?? blocks[0]?.id ?? "";
    }
    return blocks[0]?.id ?? "";
  });
  const [dimension, setDimension] = useState<WritingDimension>("argument");
  const [kind, setKind] = useState<WritingAssistanceKind>("feedback");
  const [targetBlockId, setTargetBlockId] = useState<string>(blocks[0]?.id ?? "");
  const [suggestionText, setSuggestionText] = useState("");
  const [latestDerived, setLatestDerived] = useState<{
    documentId: string;
    label: string;
    activityId: string | null;
    focusBlockId: string | null;
  } | null>(null);

  const reload = useCallback(() => setReloadCount((c) => c + 1), []);

  useEffect(() => {
    let active = true;
    setLoadError("");
    api.get(documentId, { focusBlockId, activityId })
      .then((response) => {
        if (!active) return;
        setState(response);
        onWorkspaceLoadedRef.current?.(response);
        if (response.initialized) {
          const restored = response.workspace.focusRestore.status === "exact"
            ? response.workspace.focusRestore.blockId
            : response.workspace.currentVariant.focusBlockId;
          setSelectedFocusBlockId(restored ?? blocksRef.current[0]?.id ?? "");
        }
      })
      .catch(() => {
        if (active) setLoadError("暂时无法读取写作工作区，请稍后重试。");
      });
    return () => {
      active = false;
    };
  }, [activityId, api, documentId, focusBlockId, currentRevisionNumber, reloadCount]);

  useEffect(() => {
    if (blocks.length > 0 && !blocks.some((block) => block.id === targetBlockId)) {
      setTargetBlockId(blocks[0]!.id);
    }
    if (blocks.length > 0 && selectedFocusBlockId && !blocks.some((block) => block.id === selectedFocusBlockId)) {
      setSelectedFocusBlockId(blocks[0]!.id);
    }
  }, [blocks, selectedFocusBlockId, targetBlockId]);

  function applyWorkspaceUpdate(workspace: WritingWorkspaceView) {
    const nextResponse: WritingWorkspaceResponse = { initialized: true, workspace };
    if (workspace.currentDocumentId === documentId) {
      setState(nextResponse);
      onWorkspaceLoaded?.(nextResponse);
    }
  }

  function handleActionError(error: unknown, fallback: string) {
    if (error instanceof WritingWorkspaceApiError) {
      setActionError(error.message);
      return;
    }
    setActionError(fallback);
  }

  async function handleDeriveVariant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = variantLabelInput.trim();
    if (!label || busy || hasUnsavedEdits) return;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const result = await api.command(documentId, {
        action: "derive_variant",
        expectedRevisionNumber: currentRevisionNumber,
        variantLabel: label,
        focusBlockId: selectedFocusBlockId || null,
        ...(activityId ? { activityId } : {}),
      });
      setLatestDerived({
        documentId: result.workspace.currentDocumentId,
        label: result.workspace.currentVariant.variantLabel,
        activityId: result.workspace.activityId,
        focusBlockId: result.workspace.currentVariant.focusBlockId,
      });
      setNotice(`已派生「${result.workspace.currentVariant.variantLabel}」`);
      reload();
    } catch (error) {
      handleActionError(error, "派生分支稿失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveCheckpoint(nextKept?: boolean) {
    if (busy || !state?.initialized) return;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const result = await api.command(documentId, {
        action: "save_checkpoint",
        focusBlockId: selectedFocusBlockId || null,
        ...(nextKept !== undefined ? { keptAsPreferred: nextKept } : {}),
        ...(state.workspace.activityId ? { activityId: state.workspace.activityId } : {}),
      });
      applyWorkspaceUpdate(result.workspace);
      setNotice(
        nextKept === true
          ? "已标记为本周保留稿"
          : nextKept === false
            ? "已取消本周保留稿标记"
            : "已保存续写段落位置",
      );
    } catch (error) {
      handleActionError(error, "保存续写位置失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function handleRecordFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = suggestionText.trim();
    if (!text || busy || hasUnsavedEdits) return;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const result = await api.command(documentId, {
        action: "record_feedback",
        expectedRevisionNumber: currentRevisionNumber,
        targetBlockId: targetBlockId || null,
        dimension,
        kind,
        suggestionText: text,
      });
      applyWorkspaceUpdate(result.workspace);
      setSuggestionText("");
      setNotice("已记录写作辅助建议");
    } catch (error) {
      handleActionError(error, "记录写作反馈失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function handleAdoptPolish(assistanceId: string, blockId: string, replacementText: string) {
    if (busy || hasUnsavedEdits || !state?.initialized) return;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const result = await api.command(documentId, {
        action: "adopt_suggestion",
        expectedRevisionNumber: currentRevisionNumber,
        assistanceId,
        targetBlockId: blockId,
        replacementText,
        ...(state.workspace.activityId ? { activityId: state.workspace.activityId } : {}),
      });
      applyWorkspaceUpdate(result.workspace);
      setNotice("已采纳此句润色；已记录辅助，不计入独立作答成绩");
      onDocumentUpdated?.(result.outcome?.revisionNumber ?? currentRevisionNumber + 1);
    } catch (error) {
      handleActionError(error, "采纳润色失败，请刷新后重试。");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <section className="rounded-xl border border-line bg-surface p-4" aria-label="多稿写作">
        <div className="flex items-center justify-between gap-2" role="alert">
          <p className="text-xs text-danger">{loadError}</p>
          <button type="button" className={ui.quiet} onClick={reload}>
            <RefreshCw aria-hidden="true" size={14} />
            重试读取
          </button>
        </div>
      </section>
    );
  }

  if (!state) {
    return (
      <section className="rounded-xl border border-line bg-surface p-4" aria-label="多稿写作">
        <p className="text-xs text-text-3" role="status">正在读取写作工作区…</p>
      </section>
    );
  }

  const workspace = state.initialized ? state.workspace : null;
  const liveBlockIds = new Set(blocks.map((block) => block.id));

  return (
    <section
      className="space-y-4 rounded-xl border border-line bg-surface p-4"
      aria-labelledby="writing-workspace-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
        <div className="flex items-center gap-2">
          <GitBranch aria-hidden="true" size={16} className="text-accent" />
          <h2 id="writing-workspace-heading" className="text-sm font-semibold text-text">
            多稿对比与润色
          </h2>
        </div>
        {workspace ? (
          <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">
            当前：{workspace.currentVariant.variantLabel}
          </span>
        ) : null}
      </div>

      {workspace?.focusRestore.status === "block_missing" ? (
        <p
          role="status"
          className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs leading-5 text-warn"
        >
          {workspace.focusRestore.message}
        </p>
      ) : null}

      {hasUnsavedEdits ? (
        <p role="status" className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
          当前有未保存修改，请先保存后再派生稿件或采纳润色。
        </p>
      ) : null}

      {actionError ? (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
          {actionError}
        </p>
      ) : null}

      {notice ? (
        <p role="status" className="rounded-md border border-line bg-bg px-3 py-2 text-xs text-text-2">
          {notice}
        </p>
      ) : null}

      {latestDerived ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent/30 bg-accent-soft px-3 py-2 text-xs text-text">
          <span>已生成「{latestDerived.label}」</span>
          <Link
            className={ui.quiet}
            href={variantHref(basePath, latestDerived.documentId, latestDerived.activityId, latestDerived.focusBlockId)}
          >
            打开{latestDerived.label}
          </Link>
        </div>
      ) : null}

      {!workspace ? (
        <div className="space-y-3">
          <p className="text-xs leading-5 text-text-2">
            将当前笔记纳入多稿对比，可派生不同版本、按段落记录反馈，并在下次续写时回到指定段落。
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium text-text-2">稿件版本</p>
          <ul className="space-y-1.5">
            {workspace.variants.map((variant) => {
              const isCurrent = variant.documentId === documentId;
              return (
                <li
                  key={variant.documentId}
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${
                    isCurrent ? "border-accent bg-accent-soft/40" : "border-line bg-bg"
                  }`}
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-text">{variant.variantLabel}</span>
                      <span className="text-text-3">v{variant.currentRevisionNumber}</span>
                      {variant.keptAsPreferred ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
                          <Star aria-hidden="true" size={11} />
                          本周保留稿
                        </span>
                      ) : null}
                    </div>
                    {variant.adoptedPolishCount > 0 ? (
                      <p className="text-[11px] text-text-3">
                        已采纳 {variant.adoptedPolishCount} 句润色
                      </p>
                    ) : null}
                  </div>
                  {isCurrent ? (
                    <span aria-current="page" className="text-[11px] font-medium text-accent">
                      正在编辑
                    </span>
                  ) : (
                    <Link
                      className={ui.quiet}
                      href={variantHref(basePath, variant.documentId, workspace.activityId, variant.focusBlockId)}
                    >
                      打开
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <form className="space-y-2 border-t border-line pt-3" onSubmit={(event) => void handleDeriveVariant(event)}>
        <p className="text-xs font-medium text-text-2">派生对比稿</p>
        <div className="flex flex-wrap gap-1.5">
          {PRESET_VARIANTS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={ui.quiet}
              onClick={() => setVariantLabelInput(preset)}
            >
              {preset}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">新稿名称</span>
            <input
              className={ui.input}
              value={variantLabelInput}
              onChange={(event) => setVariantLabelInput(event.target.value)}
              placeholder="例如：A 稿"
              disabled={busy || hasUnsavedEdits}
            />
          </label>
          <button
            type="submit"
            className={ui.secondary}
            disabled={busy || hasUnsavedEdits || !variantLabelInput.trim()}
          >
            派生新稿
          </button>
        </div>
      </form>

      {workspace ? (
        <div className="space-y-2 border-t border-line pt-3">
          <p className="text-xs font-medium text-text-2">续写位置与本周保留</p>
          <label className="block">
            <span className="sr-only">选择续写段落</span>
            <select
              aria-label="选择续写段落"
              className={ui.input}
              value={selectedFocusBlockId}
              onChange={(event) => setSelectedFocusBlockId(event.target.value)}
              disabled={busy}
            >
              <option value="">不指定段落</option>
              {blocks.map((block, index) => (
                <option key={block.id} value={block.id}>
                  {blockPreview(block, index)}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={ui.secondary}
              disabled={busy}
              onClick={() => void handleSaveCheckpoint()}
            >
              设为下次续写段落
            </button>
            <button
              type="button"
              className={workspace.currentVariant.keptAsPreferred ? ui.primary : ui.secondary}
              disabled={busy}
              onClick={() => void handleSaveCheckpoint(!workspace.currentVariant.keptAsPreferred)}
            >
              <Star aria-hidden="true" size={14} />
              {workspace.currentVariant.keptAsPreferred ? "已标为本周保留稿" : "标为本周保留稿"}
            </button>
          </div>
        </div>
      ) : null}

      <form className="space-y-2.5 border-t border-line pt-3" onSubmit={(event) => void handleRecordFeedback(event)}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-text-2">多维反馈与句子润色</p>
          <span className="text-[11px] text-text-3">已记录辅助，不计入独立作答成绩</span>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="评价维度">
          {(Object.keys(DIMENSION_LABELS) as WritingDimension[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={dimension === key}
              className={dimension === key ? ui.primary : ui.quiet}
              onClick={() => setDimension(key)}
            >
              {DIMENSION_LABELS[key]}
            </button>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="sr-only">辅助类型</span>
            <select
              aria-label="辅助类型"
              className={ui.input}
              value={kind}
              onChange={(event) => setKind(event.target.value as WritingAssistanceKind)}
              disabled={busy || hasUnsavedEdits}
            >
              {(Object.keys(KIND_LABELS) as WritingAssistanceKind[]).map((item) => (
                <option key={item} value={item}>
                  {KIND_LABELS[item]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="sr-only">针对段落</span>
            <select
              aria-label="针对段落"
              className={ui.input}
              value={targetBlockId}
              onChange={(event) => setTargetBlockId(event.target.value)}
              disabled={busy || hasUnsavedEdits}
            >
              <option value="">全文 / 未指定段落</option>
              {blocks.map((block, index) => (
                <option key={block.id} value={block.id}>
                  {blockPreview(block, index)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block">
          <span className="sr-only">反馈或润色内容</span>
          <textarea
            className={`${ui.input} min-h-20 resize-y`}
            value={suggestionText}
            onChange={(event) => setSuggestionText(event.target.value)}
            placeholder={kind === "polish_suggestion" ? "输入可替换该段的润色句…" : "记录论点、语言、结构或论据反馈…"}
            disabled={busy || hasUnsavedEdits}
          />
        </label>
        <button
          type="submit"
          className={ui.secondary}
          disabled={busy || hasUnsavedEdits || !suggestionText.trim()}
        >
          <Sparkles aria-hidden="true" size={14} />
          记录辅助建议
        </button>
      </form>

      {workspace && workspace.currentVariant.assistanceRecords.length > 0 ? (
        <div className="space-y-2 border-t border-line pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-text-2">已记录的反馈与润色</p>
            <span className="text-[11px] text-text-3">已记录辅助，不计入独立作答成绩</span>
          </div>
          <ul className="space-y-2">
            {workspace.currentVariant.assistanceRecords.map((record) => {
              const targetExists = record.targetBlockId !== null && liveBlockIds.has(record.targetBlockId);
              return (
                <li key={record.id} className="space-y-1.5 rounded-lg border border-line bg-bg p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <span className="font-medium text-text">
                      {DIMENSION_LABELS[record.dimension]} · {KIND_LABELS[record.kind]}
                    </span>
                    {record.adoptedAt ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent">
                        <Check aria-hidden="true" size={12} />
                        已采纳（v{record.adoptedRevisionNumber}）
                      </span>
                    ) : null}
                  </div>
                  {record.targetBlockTextSnapshot ? (
                    <p className="truncate text-[11px] text-text-3">
                      原句：{record.targetBlockTextSnapshot}
                    </p>
                  ) : null}
                  <p className="leading-5 text-text-2">{record.suggestionText}</p>
                  {record.kind === "polish_suggestion" && !record.adoptedAt ? (
                    record.targetBlockId && targetExists ? (
                      <button
                        type="button"
                        className={ui.secondary}
                        disabled={busy || hasUnsavedEdits}
                        onClick={() =>
                          void handleAdoptPolish(
                            record.id,
                            record.targetBlockId!,
                            record.suggestionText,
                          )}
                      >
                        采纳此句润色
                      </button>
                    ) : (
                      <p className="text-[11px] text-text-3">原定位段落已变化，当前无法直接替换</p>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
