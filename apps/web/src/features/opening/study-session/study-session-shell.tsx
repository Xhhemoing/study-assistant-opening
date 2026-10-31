"use client";
import { useEffect, useRef, useState } from "react";
import type { StudySessionPort, StudySessionView } from "./model";
import { reasonLabels, resultLabel } from "./model";
import { stepRenderers } from "./step-renderers";
import { ui } from "../design/ui";

export function StudySessionShell({ view, pending = false, error = "", onPrimary, onEdit, onChoosePhoto, onRemovePhoto, onHelp, onPause, onReload, onNavigate }: {
  view: StudySessionView; pending?: boolean; error?: string;
  onPrimary: () => void; onEdit: (key: string, value: string) => void; onChoosePhoto: (file: File) => void; onRemovePhoto: () => void; onHelp: () => void; onPause: () => void; onReload: () => void; onNavigate: (action: string) => void;
}) {
  const Renderer = stepRenderers[view.step.kind];
  const [helpOpen, setHelpOpen] = useState(false);
  const helpVisible = view.step.kind === "question" && (view.step.purpose !== "retest" || Boolean(view.result));
  const label = view.next?.label ?? (view.step.kind === "learn" ? "开始作答" : view.result ? "安排下一步学习" : view.locked ? "确认已提交的答案" : "提交答案");
  const reason = view.next?.reasonCode ? reasonLabels[view.next.reasonCode] : null;
  const photo = view.photo ?? { enabled: false, status: "none" as const };
  return <section className="mx-auto flex h-full max-w-4xl flex-col gap-5 overflow-auto p-5 text-text" aria-label="学习会话">
    <header className="flex items-center justify-between gap-3"><h1 className="text-lg font-semibold">{view.step.title}</h1><div className="flex items-center gap-2">{view.step.estimateMinutes != null ? <span className="text-sm text-text-2">预计 {view.step.estimateMinutes} 分钟</span> : null}<details><summary className={`${ui.quiet} cursor-pointer`}>更多</summary><div className="space-y-2 rounded-lg border border-line bg-surface p-3"><button type="button" className={ui.quiet} disabled={pending} onClick={onPause}>暂停并保存</button><button type="button" className={ui.quiet} disabled={pending} onClick={onReload}>重新读取</button></div></details></div></header>
    <main className="flex-1 space-y-5"><Renderer step={view.step} answer={view.answer} photo={photo} locked={pending || view.locked || Boolean(view.result)} onEdit={onEdit} onChoosePhoto={onChoosePhoto} onRemovePhoto={onRemovePhoto} />
      {view.result ? <section aria-label="作答结果" className="rounded-xl border border-line bg-surface-2 p-4"><h2 className="font-medium">{resultLabel(view.result)}</h2></section> : null}
      {reason ? <details className="text-sm text-text-2"><summary className="cursor-pointer">为什么</summary><p>{reason}</p></details> : null}
      {view.next?.alternatives.map(action => <button key={action.action} type="button" className={ui.quiet} onClick={() => onNavigate(action.action)}>{action.label}</button>)}
    </main>
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    <footer className="flex items-center gap-3 border-t border-line pt-4"><button type="button" data-primary-action className={ui.primary} disabled={pending || (view.step.kind === "question" && !view.result && !view.locked && !view.answer.membership)} onClick={view.next ? () => onNavigate(view.next!.action) : onPrimary}>{pending ? "正在保存与核对…" : label}</button>{helpVisible ? <button type="button" className={ui.quiet} aria-expanded={helpOpen} aria-controls="study-session-help" onClick={() => setHelpOpen(value => !value)}>需要帮助</button> : null}</footer>
    {helpOpen && helpVisible ? <aside id="study-session-help" aria-label="学习帮助" className="space-y-3 rounded-xl border border-line bg-surface-2 p-4"><div className="flex items-center justify-between"><h2 className="font-medium">先给一点提示</h2><button type="button" className={ui.quiet} onClick={() => setHelpOpen(false)}>收起帮助</button></div>{view.help.texts.map((text, index) => <p key={index} className="whitespace-pre-wrap text-sm leading-7">{text}</p>)}<button type="button" className={ui.secondary} disabled={pending || !view.help.canRequest || view.locked && !view.result} onClick={onHelp}>{view.help.hintsShown >= 3 ? "查看完整示范" : "看下一条提示"}</button></aside> : null}
  </section>;
}

/** View-model-only state owner. Ports absorb transport and protocol differences. */
export function StudySession({ port }: { port: StudySessionPort }) {
  const [view, setView] = useState<StudySessionView | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const busy = useRef(false), version = useRef(0);
  async function run(operation: () => Promise<StudySessionView | void>) {
    if (busy.current) return;
    busy.current = true; const current = version.current; setPending(true); setError("");
    try { const next = await operation(); if (current === version.current && next) setView(next); }
    catch (reason) { if (current === version.current) setError(reason instanceof Error ? reason.message : "暂时无法确认，请保留答案后重新读取。"); }
    finally { if (current === version.current) { busy.current = false; setPending(false); } }
  }
  useEffect(() => { version.current++; busy.current = false; setView(null); void run(port.load); return () => { version.current++; }; }, [port]);
  if (!view) return <section className="space-y-3 p-5"><p role="status">正在准备本次学习…</p>{error ? <><p role="alert">{error}</p><button type="button" className={ui.secondary} disabled={pending} onClick={() => void run(port.load)}>重新读取</button></> : null}</section>;
  return <StudySessionShell view={view} pending={pending} error={error} onPrimary={() => void run(port.primary)} onChoosePhoto={file => void run(() => port.choosePhoto(file))} onRemovePhoto={() => { try { setView(port.removePhoto()); } catch (reason) { setError(reason instanceof Error ? reason.message : "照片尚未移除。"); } }} onHelp={() => void run(port.help)} onPause={() => void run(port.pause)} onReload={() => void run(port.load)} onNavigate={port.navigate} onEdit={(key, value) => { try { setView(port.edit(key, value)); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "答案尚未保存。"); } }} />;
}
