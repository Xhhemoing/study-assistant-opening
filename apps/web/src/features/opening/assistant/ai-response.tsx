"use client";

import { useId, type ReactNode } from "react";

/** Decoration only: every AI state also has plain text. */
export function AiSpark({ size = 20 }: { size?: number }) {
  const id = useId();
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="shrink-0"><defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--color-ai-1)" /><stop offset=".5" stopColor="var(--color-ai-2)" /><stop offset="1" stopColor="var(--color-ai-3)" /></linearGradient></defs><path fill={`url(#${id})`} d="M12 1C13.5 8.5 15.5 10.5 23 12C15.5 13.5 13.5 15.5 12 23C10.5 15.5 8.5 13.5 1 12C8.5 10.5 10.5 8.5 12 1Z" /></svg>;
}

export function ThinkingText({ children = "正在思考…" }: { children?: ReactNode }) {
  return <p role="status" className="flex items-center gap-2 text-sm leading-6 text-text-2"><AiSpark size={16} /><span className="relative overflow-hidden">{children}<span aria-hidden="true" className="pointer-events-none absolute inset-0 -translate-x-full bg-linear-to-r from-transparent via-ai-2/15 to-transparent motion-safe:animate-shimmer motion-reduce:hidden" /></span></p>;
}

/** Reveal complete semantic blocks so math, citations and selection offsets stay intact. */
export function StreamText({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return <div aria-busy={busy} className="font-reading text-[17px] leading-[30px] motion-safe:animate-enter">{children}</div>;
}

export function ReplyCard({ children }: { children: ReactNode }) {
  return <div className="rounded-card border border-line bg-surface p-4 shadow-card">{children}</div>;
}
