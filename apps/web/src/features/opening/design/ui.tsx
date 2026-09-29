import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, BookOpen, Compass, FileText, RefreshCw } from "lucide-react";

const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-1";
const motion = "transition-colors duration-150 motion-reduce:transition-none";
const field = "min-w-0 w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-zinc-800 placeholder:text-zinc-500 focus:border-emerald-700 focus:outline-none focus:ring-1 focus:ring-emerald-700 disabled:opacity-50";
export const ui = {
  primary: `inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 md:pointer-fine:min-h-8 ${motion} ${focus}`,
  secondary: `inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 md:pointer-fine:min-h-8 ${motion} ${focus}`,
  quiet: `inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40 md:pointer-fine:min-h-8 ${motion} ${focus}`,
  icon: `inline-flex size-10 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40 md:pointer-fine:size-8 ${motion} ${focus}`,
  input: `${field} min-h-10 text-sm md:pointer-fine:min-h-8 md:pointer-fine:text-xs`,
  panel: "border border-zinc-200 bg-white",
  label: "text-xs font-medium text-zinc-600",
} as const;
export const buttonClass = ui.primary;
export const secondaryButtonClass = ui.secondary;
export const inputClass = ui.input;
export const selectClass = ui.input;
export const textareaClass = `${field} min-h-24 resize-y text-sm leading-7`;
export const panelClass = ui.panel;
export function PageHeading({ title, description, action, actions }: { title: string; description?: ReactNode; action?: ReactNode; actions?: ReactNode }) {
  return <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3">
    <div className="min-w-0"><h1 className="text-base font-semibold tracking-tight text-zinc-900">{title}</h1>
      {description ? <p className="mt-1 max-w-3xl text-xs leading-6 text-zinc-500">{description}</p> : null}</div>{action ?? actions}
  </header>;
}
export const PageHeader = PageHeading;
export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return <div className="mx-auto flex max-w-md flex-col items-center px-5 py-10 text-center">
    <BookOpen size={24} className="mb-4 text-zinc-400" aria-hidden="true" /><h2 className="text-sm font-semibold text-zinc-800">{title}</h2>
    {description ? <p className="mt-2 text-sm leading-7 text-zinc-500">{description}</p> : null}{action ? <div className="mt-4">{action}</div> : null}
  </div>;
}
export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="rounded-md border border-amber-200 bg-amber-50 p-3" role="alert"><p className="text-xs leading-6 text-amber-900">{message}</p>
    {onRetry ? <button type="button" className={`${ui.secondary} mt-2`} onClick={onRetry}><RefreshCw size={13} aria-hidden="true" />重新读取</button> : null}
  </div>;
}
export const ErrorNotice = LoadError;
export function LoadingRows({ label = "正在读取你的学习内容" }: { label?: string }) {
  return <div className="space-y-4 p-4" role="status" aria-label={label}><span className="sr-only">{label}</span>
    {[0, 1, 2].map(row => <div key={row} className="flex items-center gap-3"><div className="size-6 rounded bg-zinc-100" /><div className="flex-1 space-y-2"><div className="h-2.5 w-2/3 rounded bg-zinc-100" /><div className="h-2 w-1/3 rounded bg-zinc-100" /></div></div>)}
  </div>;
}
export function EntryLinks() {
  return <nav aria-label="三种学习入口" className="flex flex-wrap gap-1">{[
    { title: "目标学习", href: "/learn", icon: BookOpen }, { title: "自由探索", href: "/explore", icon: Compass }, { title: "知识库", href: "/library", icon: FileText },
  ].map(({ title, href, icon: Icon }) => <Link key={href} href={href} className={ui.quiet}><Icon size={14} aria-hidden="true" />{title}<ArrowUpRight size={12} aria-hidden="true" /></Link>)}</nav>;
}
