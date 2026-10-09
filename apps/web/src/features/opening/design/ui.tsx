import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, BookOpen, ClipboardCheck, Layers2, Link2, Notebook, RefreshCw, Sun, type LucideIcon } from "lucide-react";

const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50 focus-visible:ring-offset-2 focus-visible:ring-offset-white";
// Press feedback scales the control instead of shifting layout; reduced motion keeps colors only.
const motion = "transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out-expo active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100";
const control = "inline-flex min-h-10 select-none items-center justify-center gap-1.5 rounded-lg text-xs font-medium disabled:pointer-events-none disabled:opacity-40 md:pointer-fine:min-h-8";
const field = "min-w-0 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-zinc-800 shadow-xs shadow-zinc-900/5 transition-[border-color,box-shadow] duration-150 placeholder:text-zinc-400 hover:border-zinc-300 focus:border-emerald-600 focus:outline-none focus:ring-4 focus:ring-emerald-600/10 disabled:opacity-50 motion-reduce:transition-none";
export const ui = {
  primary: `${control} bg-zinc-900 px-3 text-white shadow-sm shadow-zinc-900/20 hover:bg-zinc-800 ${motion} ${focus}`,
  secondary: `${control} border border-zinc-200 bg-white px-2.5 text-zinc-700 shadow-xs shadow-zinc-900/5 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900 ${motion} ${focus}`,
  quiet: `${control} px-2 font-normal text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950 ${motion} ${focus}`,
  icon: `inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-zinc-100 aria-pressed:text-zinc-950 md:pointer-fine:size-8 ${motion} ${focus}`,
  input: `${field} min-h-10 text-sm md:pointer-fine:min-h-8 md:pointer-fine:text-xs`,
  panel: "rounded-xl border border-zinc-200/80 bg-white shadow-xs shadow-zinc-900/5",
  label: "text-xs font-medium text-zinc-600",
  /** Small status chip; pair with a tone from `tone`. */
  badge: "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium leading-none",
  /** Sliding segmented control container and item. */
  segment: "flex rounded-lg bg-zinc-100 p-0.5",
  segmentItem: `min-h-10 flex-1 rounded-md px-2 text-xs text-zinc-600 transition-[color,background-color,box-shadow] duration-200 ease-out-expo hover:text-zinc-900 aria-pressed:bg-white aria-pressed:font-medium aria-pressed:text-zinc-900 aria-pressed:shadow-sm aria-pressed:shadow-zinc-900/10 motion-reduce:transition-none md:min-h-8 ${focus}`,
} as const;
/** Semantic tones: emerald = progress/AI-accepted, amber = needs attention, red = failure only. */
export const tone = {
  neutral: "bg-zinc-100 text-zinc-700",
  success: "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-600/15",
  warning: "bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-600/20",
  danger: "bg-red-50 text-red-800 ring-1 ring-inset ring-red-600/15",
} as const;
export const buttonClass = ui.primary;
export const secondaryButtonClass = ui.secondary;
export const inputClass = ui.input;
export const selectClass = ui.input;
export const textareaClass = `${field} min-h-24 resize-y text-sm leading-7`;
export const panelClass = ui.panel;
export function PageHeading({ title, description, action, actions }: { title: string; description?: ReactNode; action?: ReactNode; actions?: ReactNode }) {
  return <header className="flex min-h-16 flex-wrap items-end justify-between gap-3 border-b border-zinc-200/80 px-5 pb-4 pt-5 sm:px-7">
    <div className="min-w-0 motion-safe:animate-enter"><h1 className="text-lg font-semibold tracking-tight text-zinc-950">{title}</h1>
      {description ? <p className="mt-1 max-w-3xl text-[13px] leading-6 text-zinc-500">{description}</p> : null}</div>{action ?? actions}
  </header>;
}
export const PageHeader = PageHeading;
export function EmptyState({ title, description, action, icon: Icon = BookOpen }: { title: string; description?: ReactNode; action?: ReactNode; icon?: LucideIcon }) {
  return <div className="mx-auto flex max-w-md flex-col items-center px-5 py-12 text-center motion-safe:animate-enter">
    <span className="mb-4 inline-flex size-12 items-center justify-center rounded-2xl bg-gradient-to-b from-zinc-50 to-zinc-100 text-zinc-500 shadow-xs ring-1 ring-zinc-900/5" aria-hidden="true"><Icon size={20} strokeWidth={1.75} /></span>
    <h2 className="text-[15px] font-semibold text-zinc-900">{title}</h2>
    {description ? <p className="mt-1.5 text-sm leading-6 text-zinc-500">{description}</p> : null}{action ? <div className="mt-5">{action}</div> : null}
  </div>;
}
export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className={`rounded-xl p-3 ${tone.warning}`} role="alert"><p className="text-xs leading-6">{message}</p>
    {onRetry ? <button type="button" className={`${ui.secondary} mt-2`} onClick={onRetry}><RefreshCw size={13} aria-hidden="true" />重新读取</button> : null}
  </div>;
}
export const ErrorNotice = LoadError;
/** Skeleton bar with a composited shimmer sweep (transform only). */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`relative overflow-hidden rounded-md bg-zinc-100 ${className}`} aria-hidden="true"><div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/70 to-transparent motion-safe:animate-shimmer" /></div>;
}
export function LoadingRows({ label = "正在读取你的学习内容" }: { label?: string }) {
  return <div className="space-y-4 p-4" role="status" aria-label={label}><span className="sr-only">{label}</span>
    {[0, 1, 2].map(row => <div key={row} className="flex items-center gap-3"><Skeleton className="size-8 rounded-lg" /><div className="flex-1 space-y-2"><Skeleton className="h-2.5 w-2/3" /><Skeleton className="h-2 w-1/3" /></div></div>)}
  </div>;
}
export function EntryLinks() {
  return <nav aria-label="学习闭环入口" className="flex flex-wrap gap-1">{[
    { title: "今日", href: "/opening/today", icon: Sun },
    { title: "卡片", href: "/opening/cards", icon: Layers2 },
    { title: "待确认", href: "/opening/review", icon: ClipboardCheck },
    { title: "课程", href: "/opening/courses", icon: Notebook },
    { title: "连接", href: "/opening/settings/connections", icon: Link2 },
  ].map(({ title, href, icon: Icon }) => <Link key={href} href={href} className={ui.quiet}><Icon size={14} aria-hidden="true" />{title}<ArrowUpRight size={12} aria-hidden="true" /></Link>)}</nav>;
}
