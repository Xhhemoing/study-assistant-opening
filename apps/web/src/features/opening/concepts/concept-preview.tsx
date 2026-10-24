"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { BookOpen, X } from "lucide-react";
import { LearningProse } from "../assistant/learning-prose";
import { ui } from "../design/ui";
import { captureReaderReturnPoint, restoreReaderReturnPoint, type ReaderReturnPoint } from "../inbox/reader-return-point";
import type { ReaderSelection } from "../inbox/source-reader-selection";
import type { ConceptPreviewRequest, ConceptPreviewResponse } from "./preview-contract";

export type ConceptPreviewLoader = (request: ConceptPreviewRequest, signal: AbortSignal) => Promise<ConceptPreviewResponse>;
export type ConceptPreviewHandle = { close: () => boolean };
type Props = {
  /** Changes of authority (including protected-question mode) discard all local state. No shared cache. */
  bindingKey: string;
  sourceId: string;
  sourceLabel: string;
  sourceVersion: number;
  selection: ReaderSelection | null;
  load: ConceptPreviewLoader;
  questionProtected?: boolean;
  onContinue: (selection: ReaderSelection) => void;
};
type PreviewState = { status: "loading" } | { status: "error"; reason: string } | ConceptPreviewResponse;
type Intent = { request: ConceptPreviewRequest; selection: ReaderSelection };

const labels = { unavailable: "暂无可核对的原文", ambiguous: "选中文字不唯一", restricted: "当前内容受限", stale: "材料版本已失效", error: "预览未能加载" };
const reasonLabels: Record<string, string> = {
  reader_preview_restricted_material_or_open_attempt: "当前资料暂不开放概念预览，或有进行中的作答。若正在作答，请返回原题，并从原题的提问入口继续，以保留帮助记录。",
  source_version_unavailable: "这份资料的版本暂不可用，请重新打开资料后选择。",
  source_page_unavailable: "暂时无法读取这一页，请在原文中核对或稍后重试。",
  selection_not_uniquely_verified: "无法在这一页唯一核对选中文字，请缩小或重新选择原文。",
};

const BoundPreview = forwardRef<ConceptPreviewHandle, Props>(function BoundPreview(props, ref) {
  const [intent, setIntent] = useState<Intent | null>(null);
  const [state, setState] = useState<PreviewState | null>(null);
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const origin = useRef<ReaderReturnPoint | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const open = useRef(false);
  function close() {
    if (!open.current) return false;
    open.current = false; sequence.current++; pending.current?.abort();
    setIntent(null); setState(null);
    if (origin.current) restoreReaderReturnPoint(origin.current);
    origin.current = null;
    return true;
  }
  useImperativeHandle(ref, () => ({ close }));
  useEffect(() => () => { sequence.current++; pending.current?.abort(); }, []);
  useEffect(() => { if (intent) closeButton.current?.focus({ preventScroll: true }); }, [intent]);
  async function run(next: Intent) {
    const ticket = ++sequence.current;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setState({ status: "loading" });
    try {
      const result = await props.load(next.request, controller.signal);
      if (ticket !== sequence.current || controller.signal.aborted) return;
      // Do not display or hand off an excerpt bound to a different material revision/page.
      if (result.status === "available" && (result.locator.sourceId !== next.request.sourceId || result.locator.sourceVersion !== next.request.sourceVersion || result.locator.page !== next.request.page)) {
        setState({ status: "stale", reason: "预览来源与当前选区不一致，请重新选择。" });
      } else setState(result);
    } catch (reason) {
      if (ticket !== sequence.current || controller.signal.aborted) return;
      setState({ status: "error", reason: reason instanceof Error ? reason.message : "请稍后重试。" });
    }
  }
  function show(opener: HTMLButtonElement) {
    const selected = props.selection;
    if (!selected || selected.sourceId !== props.sourceId || selected.version !== props.sourceVersion) {
      setNotice("选区已失效，请重新选择。"); return;
    }
    if (!selected.page || selected.text.length > 1200) {
      setNotice("请选择有物理页码的原文，且不超过 1,200 字；也可使用原提问入口。"); return;
    }
    if (props.questionProtected) { setNotice("请从原题的提问入口继续，以保留帮助记录。"); return; }
    if (!open.current) origin.current = captureReaderReturnPoint(document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : opener);
    const frozen = { ...selected };
    const next: Intent = { selection: frozen, request: { sourceId: frozen.sourceId, sourceVersion: frozen.version, page: frozen.page!, term: frozen.text.slice(0, 240), selection: { text: frozen.text }, clientKey: `preview:${crypto.randomUUID()}` } };
    open.current = true; setNotice(""); setIntent(next); void run(next);
  }
  return <div className="shrink-0 space-y-2">
    <button type="button" className={ui.secondary} onPointerDown={event => event.preventDefault()} onClick={event => show(event.currentTarget)} disabled={props.questionProtected}><BookOpen size={16} aria-hidden="true" />查看概念</button>
    {notice ? <p role="status" className="text-xs text-text-2">{notice}</p> : null}
    {intent && state ? <section role="region" aria-label="概念预览" aria-busy={state.status === "loading"} className="max-h-[45dvh] space-y-3 overflow-auto overscroll-contain rounded border border-line bg-popover p-3 text-sm" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <header className="flex items-center justify-between gap-2"><h2 className="font-semibold">概念预览 · 材料原文</h2><button ref={closeButton} type="button" className={ui.secondary} aria-label="关闭概念预览" onClick={close}><X size={16} aria-hidden="true" /></button></header>
      <p className="text-xs text-text-2">v{intent.selection.version} · 物理第 {intent.selection.page} 页 · 此处不是 AI 生成的解释。</p>
      {state.status === "loading" ? <p role="status">正在核对原文…</p> : state.status === "available" ? <>
        <p className="text-xs text-text-2">{state.context.expanded ? "已扩展显示同一物理页内、原选区所在段落的上下文。" : "当前显示原选区，未扩展上下文。"}继续问只带入原选区，不会自动带入扩展内容。</p>
        <div aria-label="原选区" className="rounded border border-line p-2"><p className="mb-1 text-xs text-text-2">原选区</p><LearningProse text={state.selection.text} /></div>
        {state.context.truncatedBefore ? <p className="text-xs text-text-2">… 前文已截断</p> : null}
        <LearningProse text={state.text} />
        {state.context.truncatedAfter ? <p className="text-xs text-text-2">后文已截断 …</p> : null}
        <p className="break-words text-xs text-text-2" data-preview-citation="true">来源：{props.sourceLabel} · v{state.locator.sourceVersion} · 第 {state.locator.page} 页</p>
        <details className="break-all text-xs text-text-2" data-preview-diagnostics="true"><summary>诊断信息</summary><p>资料 ID：{state.locator.sourceId} · 上下文字符 {state.locator.start}–{state.locator.end} · 原选区字符 {state.selection.start}–{state.selection.end} · 材料修订 {state.locator.manifestRevision}</p></details>
      </> : <><p role={state.status === "error" ? "alert" : "status"}>{labels[state.status]}：{reasonLabels[state.reason] ?? (state.status === "restricted" ? "当前暂不开放此预览。若正在作答，请返回原题，并从原题的提问入口继续。" : state.reason)}</p>{state.status === "restricted" ? <details className="text-xs text-text-2" data-preview-diagnostics="true"><summary>诊断信息</summary><p>{state.reason}</p></details> : null}</>}
      <footer className="flex flex-wrap gap-2">
        {state.status === "error" ? <button type="button" className={ui.secondary} onClick={() => void run(intent)}>重试预览</button> : null}
        <button type="button" className={ui.secondary} disabled={props.questionProtected || state.status === "loading" || state.status === "restricted" || state.status === "stale"} onClick={() => { const frozen = intent.selection; close(); props.onContinue(frozen); }}>继续问</button>
      </footer>
    </section> : null}
  </div>;
});

/** Keying authority prevents even one render of a previous binding's result. */
export const ConceptPreview = forwardRef<ConceptPreviewHandle, Props>(function ConceptPreview(props, ref) {
  return <BoundPreview key={`${props.bindingKey}:${props.sourceId}:${props.sourceVersion}:${Boolean(props.questionProtected)}`} ref={ref} {...props} />;
});
