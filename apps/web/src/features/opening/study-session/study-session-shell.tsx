"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { LearningProse } from "../assistant/learning-prose";
import { SuccessCheck } from "../v3/motion/feedback";
import { useTransitionRouter } from "../v3/motion/view-transition";
import { ui } from "../design/ui";
import { primaryAction, resultLabel, type StudySessionPort, type StudySessionView } from "./model";
import { StepRenderer } from "./step-renderers";

type Handlers = {
  onPrimary: () => void; onHelp: () => void; onPause: () => void; onReload: () => void;
  onEdit: Parameters<typeof StepRenderer>[0]["onEdit"]; onChoosePhoto: (file: File) => void; onRemovePhoto: () => void;
  onSelectGrade?: Parameters<typeof StepRenderer>[0]["onSelectGrade"];
  onRedo?: () => void;
};

/** One session screen: top bar, the current step, one primary action. Help and "more" open on demand. */
export function StudySessionShell({ view, pending = false, error = "", content, ...on }: { view: StudySessionView; pending?: boolean; error?: string; content?: ReactNode } & Handlers) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const helpId = useId(), moreId = useId();
  const helpButton = useRef<HTMLButtonElement>(null);
  const primary = primaryAction(view, pending);
  const locked = pending || view.sealed || Boolean(view.result);
  const questionStep = view.step.kind === "question" ? view.step : null;
  const helpAllowed = questionStep !== null && !(questionStep.purpose === "retest" && !view.result);
  useEffect(() => { setHelpOpen(false); setMoreOpen(false); }, [view.step.id]);
  useEffect(() => { if (!helpAllowed) setHelpOpen(false); }, [helpAllowed]);
  useEffect(() => {
    if (!helpOpen && !moreOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (helpOpen) { setHelpOpen(false); helpButton.current?.focus(); } else setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [helpOpen, moreOpen]);

  return <section className="mx-auto flex min-h-full max-w-(--layout-prose) flex-col text-text" aria-label="学习会话">
    <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-bg/95 px-4 py-2 backdrop-blur">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold">{view.step.title}</h1>
        <ol className="mt-1.5 flex max-w-64 gap-1" aria-label={`第 ${view.position.index + 1} 步，共 ${view.position.total} 步`}>
          {Array.from({ length: view.position.total }, (_, index) => <li key={index}
            className={`h-1 flex-1 rounded-pill transition-colors duration-(--duration-state) ${index < view.position.index ? "bg-text-3" : index === view.position.index ? "bg-text" : "bg-line"}`} />)}
        </ol>
      </div>
      {view.step.estimateMinutes != null ? <span className="shrink-0 text-xs tabular-nums text-text-2">约 {view.step.estimateMinutes} 分钟</span> : null}
      {view.step.kind !== "photo_practice" ? <div className="relative">
        <button type="button" className={ui.icon} aria-label="更多" aria-haspopup="menu" aria-expanded={moreOpen} aria-controls={moreId} onClick={() => setMoreOpen(value => !value)}>⋯</button>
        {moreOpen ? <div id={moreId} role="menu" className="absolute right-0 top-10 z-20 grid min-w-40 rounded-tile border border-line bg-popover p-1 shadow-float motion-safe:animate-pop">
          {view.step.kind !== "card" ? <button type="button" role="menuitem" className={`${ui.quiet} justify-start`} disabled={pending} onClick={() => { setMoreOpen(false); on.onPause(); }}>暂停并保存</button> : null}
          <button type="button" role="menuitem" className={`${ui.quiet} justify-start`} disabled={pending} onClick={() => { setMoreOpen(false); on.onReload(); }}>重新读取</button>
        </div> : null}
      </div> : null}
    </header>

    <main key={view.step.id} className="flex-1 space-y-6 px-4 py-6 motion-safe:animate-text-in">
      <StepRenderer step={view.step} answer={view.answer} locked={locked} photo={view.photo}
        onEdit={on.onEdit} onSelectGrade={on.onSelectGrade} onChoosePhoto={on.onChoosePhoto} onRemovePhoto={on.onRemovePhoto} content={content} />
      {view.result ? <section aria-live="polite" aria-label="作答结果" className="space-y-2 rounded-tile border border-line bg-surface p-4 motion-safe:animate-pop">
        <p className="flex items-center gap-2 font-medium">
          {view.result.outcome === "correct" ? <SuccessCheck play label="" /> : null}{resultLabel(view.result)}
        </p>
        {view.result.detail ? <p className="text-sm leading-7 text-text-2">{view.result.detail}</p> : null}
        {view.result.nextStep ? <div className="rounded-tile border border-line bg-accent-soft p-3 text-sm leading-7"><p className="font-medium">下一步：{view.result.nextStep.label}</p><p>{view.result.nextStep.action}</p></div> : null}
        {view.next?.reason ? <p className="text-sm leading-7 text-text-2">{view.next.reason}</p> : null}
        {view.canRedo && on.onRedo ? <button type="button" className={ui.secondary} disabled={pending} onClick={on.onRedo}>改这道题</button> : null}
      </section> : null}
      {view.next?.alternatives.length ? <div className="flex flex-wrap gap-2">{view.next.alternatives.map(link =>
        <a key={link.href} className={ui.quiet} href={link.href}>{link.label}</a>)}</div> : null}
      {view.blocked ? <p role="alert" className="text-sm text-warn">{view.blocked}</p> : null}
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    </main>

    {view.step.kind !== "photo_practice" || primary.kind !== "none" ? <footer className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur">
      {helpAllowed ? <button ref={helpButton} type="button" className={ui.quiet} aria-expanded={helpOpen} aria-controls={helpId}
        onClick={() => setHelpOpen(value => !value)}>{view.help.hints.length ? `提示 · 已看 ${view.help.hints.length}` : "提示"}</button> : <span />}
      <button type="button" data-primary-action className={ui.primary} disabled={primary.disabled} aria-busy={pending || undefined} onClick={on.onPrimary}>
        {pending ? "正在保存…" : primary.label}
      </button>
    </footer> : null}

    {helpAllowed && helpOpen ? <aside id={helpId} aria-label="提示" className="fixed inset-x-0 bottom-0 z-30 max-h-[70dvh] space-y-3 overflow-auto rounded-t-(--radius-sheet) border border-line bg-popover p-4 shadow-overlay motion-safe:animate-sheet-in lg:inset-y-0 lg:left-auto lg:w-(--layout-companion) lg:max-h-none lg:rounded-none lg:motion-safe:animate-panel-in">
      <div className="flex items-center justify-between"><h2 className="font-medium">提示</h2>
        <button type="button" className={ui.quiet} onClick={() => { setHelpOpen(false); helpButton.current?.focus(); }}>收起</button></div>
      {view.help.hints.length ? <ol className="space-y-2">{view.help.hints.map(hint => <li key={hint.level} className="rounded-tile bg-surface-2 p-3 motion-safe:animate-text-in">
        <p className="text-xs text-text-3">{hint.level}. {hint.label}</p>
        <div className="prose-reading text-sm leading-7"><LearningProse text={hint.text} /></div>
      </li>)}</ol> : <p className="text-sm text-text-2">提示一次给一点，你的答案会保留。用过提示，这题会如实记为「用提示后答对」。</p>}
      {view.help.next ? <button type="button" className={ui.secondary} disabled={pending} onClick={on.onHelp}>看第 {view.help.next.level} 步：{view.help.next.label}</button>
        : view.help.blockedReason ? <p className="text-sm text-text-2">{view.help.blockedReason}</p> : null}
    </aside> : null}
  </section>;
}

/** State owner. It only talks to the port; every API detail lives in the adapter. */
export function StudySession({ port }: { port: StudySessionPort }) {
  const [view, setView] = useState<StudySessionView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false), generation = useRef(0);
  const router = useTransitionRouter(true);
  async function run(operation: () => Promise<StudySessionView | void>) {
    if (busy.current) return;
    busy.current = true; const current = generation.current; setPending(true); setError("");
    try { const next = await operation(); if (current === generation.current && next) setView(next); }
    catch (reason) { if (current === generation.current) setError(reason instanceof Error ? reason.message : "这一步还没确认，答案已保留，请重新读取。"); }
    finally { if (current === generation.current) { busy.current = false; setPending(false); } }
  }
  function sync(operation: () => StudySessionView) {
    try { setView(operation()); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "答案还没保存。"); }
  }
  useEffect(() => {
    generation.current++; busy.current = false; setView(null);
    void run(port.load);
    return () => { generation.current++; };
  }, [port]);
  if (!view) return <section className="space-y-3 p-5" aria-label="学习会话">
    <p role="status" className="text-sm text-text-2">正在准备这一步…</p>
    {error ? <><p role="alert" className="text-sm text-danger">{error}</p><button type="button" className={ui.secondary} disabled={pending} onClick={() => void run(port.load)}>重新读取</button></> : null}
  </section>;
  const go = (href: string) => { if (router) router.push(href); else window.location.assign(href); };
  return <StudySessionShell view={view} pending={pending} error={error}
    onPrimary={() => { if (view.next && !view.blocked) go(view.next.href); else void run(port.primary); }}
    onHelp={() => void run(port.help)} onPause={() => void run(port.pause)} onReload={() => void run(port.load)}
    onRedo={port.redo ? () => void run(port.redo!) : undefined}
    onEdit={change => sync(() => port.edit(change))} onChoosePhoto={file => void run(() => port.choosePhoto(file))} onRemovePhoto={() => sync(port.removePhoto)} />;
}
