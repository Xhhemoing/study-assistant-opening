"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { LearningProse } from "../assistant/learning-prose";
import { SuccessCheck } from "../v3/motion/feedback";
import { ui } from "../design/ui";
import { resultLabel, type ConversationEntry, type StudySessionView } from "./model";

type Props = {
  history: ConversationEntry[];
  view: StudySessionView;
  /** The current step, rendered by the shell's StepRenderer. */
  step: ReactNode;
  /** Secondary actions that belong to the feedback (redo, continue without a successor card). */
  feedbackActions?: ReactNode;
  /** The successor card's single action; null renders no card. */
  successor: { action: ReactNode } | null;
};

/** The span session as one chronological conversation: earlier steps, the current step, my answer, feedback, then what comes next. */
export function ConversationThread({ history, view, step, feedbackActions, successor }: Props) {
  const list = useRef<HTMLOListElement>(null);
  const latest = `${history.length}:${view.step.id}:${view.result ? "result" : ""}:${successor ? "next" : ""}`;
  const seen = useRef(latest);
  useEffect(() => {
    if (seen.current === latest) return;
    seen.current = latest;
    // Focus stays where the learner is; only the newest entry scrolls into view where the browser supports it.
    const last = list.current?.lastElementChild;
    if (!(last instanceof HTMLElement) || typeof last.scrollIntoView !== "function") return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    last.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [latest]);
  const reasons = Boolean(view.result?.detail || view.result?.nextStep);

  return <ol ref={list} aria-label="学习对话" className="space-y-6">
    {history.map(entry => <li key={`history:${entry.stepId}`} aria-label={`已完成：${entry.title}`}
      className="space-y-1 rounded-tile border border-line bg-surface-2 p-3 text-sm leading-7 text-text-2">
      {entry.body ? <details>
        <summary className="cursor-pointer font-medium text-text">{entry.title}</summary>
        <div className="prose-reading mt-2"><LearningProse text={entry.body} /></div>
      </details> : <p className="font-medium text-text">{entry.title}</p>}
      {entry.answerSummary ? <p>我的作答：{entry.answerSummary}</p> : null}
      {entry.resultLabel ? <p>{entry.resultLabel}</p> : null}
    </li>)}
    <li key={`step:${view.step.id}`} className="motion-safe:animate-text-in">{step}</li>
    {view.sealed && view.answerSummary ? <li className="flex justify-end motion-safe:animate-text-in">
      <section aria-label="我的作答" className="max-w-[85%] space-y-1 rounded-tile bg-accent-soft p-3 text-sm leading-7">
        <p className="text-xs text-text-2">我的作答</p>
        <p>{view.answerSummary}</p>
      </section>
    </li> : null}
    {view.result ? <li>
      <section aria-live="polite" aria-label="作答结果" className="space-y-2 rounded-tile border border-line bg-surface p-4 motion-safe:animate-pop">
        <p className="flex items-center gap-2 font-medium">
          {view.result.outcome === "correct" ? <SuccessCheck play label="" /> : null}{resultLabel(view.result)}
        </p>
        {reasons ? <details className="text-sm leading-7 text-text-2">
          <summary className="cursor-pointer">为什么</summary>
          <div className="mt-2 space-y-2">
            {view.result.detail ? <p>{view.result.detail}</p> : null}
            {view.result.nextStep ? <div className="rounded-tile border border-line bg-accent-soft p-3 text-text"><p className="font-medium">下一步：{view.result.nextStep.label}</p><p>{view.result.nextStep.action}</p></div> : null}
          </div>
        </details> : null}
        {feedbackActions}
      </section>
    </li> : null}
    {successor ? <li>
      <section aria-live="polite" aria-label="下一步" className="space-y-3 rounded-tile border border-line bg-surface p-4 motion-safe:animate-pop">
        <h2 className="text-xs font-medium text-text-2">下一步</h2>
        {view.next ? <p className="font-medium">{view.next.label}</p> : null}
        {view.next?.notice ? <p className="text-sm leading-7">{view.next.notice}</p> : null}
        {view.next?.reason ? <details className="text-sm leading-7 text-text-2">
          <summary className="cursor-pointer">为什么</summary>
          <p className="mt-2">{view.next.reason}</p>
        </details> : null}
        <div className="flex flex-wrap items-center gap-2">
          {successor.action}
          {view.next?.alternatives.map(link => <a key={link.href} className={ui.quiet} href={link.href}>{link.label}</a>)}
        </div>
      </section>
    </li> : null}
  </ol>;
}
