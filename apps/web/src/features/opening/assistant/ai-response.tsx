"use client";

import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { interactionMotionReduced } from "../design/haptics";

export const ReplyRevealEnabled = createContext(false);
const ReplyRevealStep = createContext(Number.POSITIVE_INFINITY);

/** Full text stays in the DOM, with stable layout, selection and accessibility. */
export function ReplyTextGroup({ order, children }: { order: number; children: ReactNode }) {
  const step = useContext(ReplyRevealStep);
  return <span data-reply-text-group={order} className={order <= step ? "opacity-100" : "opacity-0"}>{children}</span>;
}

/** Decoration only: every AI state also has plain text. */
export function AiSpark({ size = 20 }: { size?: number }) {
  const id = useId();
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="shrink-0"><defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--color-ai-1)" /><stop offset=".5" stopColor="var(--color-ai-2)" /><stop offset="1" stopColor="var(--color-ai-3)" /></linearGradient></defs><path fill={`url(#${id})`} d="M12 1C13.5 8.5 15.5 10.5 23 12C15.5 13.5 13.5 15.5 12 23C10.5 15.5 8.5 13.5 1 12C8.5 10.5 10.5 8.5 12 1Z" /></svg>;
}

export function ThinkingText({ children = "正在思考…" }: { children?: ReactNode }) {
  return <p role="status" className="flex items-center gap-2 text-sm leading-6 text-text-2"><AiSpark size={16} /><span className="relative overflow-hidden">{children}<span aria-hidden="true" className="pointer-events-none absolute inset-0 -translate-x-full bg-linear-to-r from-transparent via-ai-2/15 to-transparent motion-safe:animate-shimmer motion-reduce:hidden" /></span></p>;
}

/** Display animation after a reply arrives; this does not simulate token streaming. */
export function StreamText({ children, busy = false, reveal = false }: { children: ReactNode; busy?: boolean; reveal?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(Number.POSITIVE_INFINITY);
  const finishReveal = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    if (!reveal || busy) return;
    if (interactionMotionReduced()) return;
    const total = host.current?.querySelectorAll("[data-reply-text-group]").length ?? 0;
    if (!total) return;
    setStep(0);
    let next = 0;
    const timer = window.setInterval(() => {
      next++;
      setStep(next >= total ? Number.POSITIVE_INFINITY : next);
      if (next >= total) window.clearInterval(timer);
    }, 20);
    // Long answers never demand a long wait. Any interaction also reveals all.
    const finish = () => { window.clearInterval(timer); setStep(Number.POSITIVE_INFINITY); };
    finishReveal.current = finish;
    const deadline = window.setTimeout(finish, 2500);
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const onPreference = () => { if (interactionMotionReduced()) finish(); };
    preference?.addEventListener?.("change", onPreference);
    const observer = new MutationObserver(onPreference);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    return () => { window.clearInterval(timer); window.clearTimeout(deadline); preference?.removeEventListener?.("change", onPreference); observer.disconnect(); };
  }, [busy, reveal]);
  const showAll = () => { finishReveal.current(); setStep(Number.POSITIVE_INFINITY); };
  return <ReplyRevealEnabled.Provider value={reveal}><ReplyRevealStep.Provider value={step}>
    <div ref={host} aria-busy={busy} onPointerDownCapture={showAll} onFocusCapture={showAll} onKeyDownCapture={showAll} className="font-reading text-[17px] leading-[30px] motion-safe:animate-enter">{children}</div>
  </ReplyRevealStep.Provider></ReplyRevealEnabled.Provider>;
}

export function ReplyCard({ children }: { children: ReactNode }) {
  return <div className="rounded-card border border-line bg-surface p-4 shadow-card">{children}</div>;
}
