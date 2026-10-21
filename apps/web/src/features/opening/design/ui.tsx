import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, ClipboardCheck, Layers2, Link2, Notebook, Sun } from "lucide-react";

import { ui, fieldClass } from "@aistudy/ui";
export { ui, tone, EmptyState, Skeleton, LoadingRows } from "@aistudy/ui";
export { ErrorState as LoadError, ErrorState as ErrorNotice } from "@aistudy/ui";

export const buttonClass = ui.primary;
export const secondaryButtonClass = ui.secondary;
export const inputClass = ui.input;
export const selectClass = ui.input;
export const textareaClass = `${fieldClass} min-h-24 resize-y text-sm leading-7`;
export const panelClass = ui.panel;
export function PageHeading({ title, description, action, actions }: { title: string; description?: ReactNode; action?: ReactNode; actions?: ReactNode }) {
  return <header className="flex min-h-16 flex-wrap items-end justify-between gap-3 border-b border-line px-5 pb-4 pt-5 sm:px-7">
    <div className="min-w-0 motion-safe:animate-enter"><h1 className="font-serif text-[26px] font-medium leading-[34px] text-text sm:text-[30px] sm:leading-10">{title}</h1>
      {description ? <p className="mt-1 max-w-3xl text-[13px] leading-6 text-text-2">{description}</p> : null}</div>{action ?? actions}
  </header>;
}
export const PageHeader = PageHeading;
export function EntryLinks() {
  return <nav aria-label="学习闭环入口" className="flex flex-wrap gap-1">{[
    { title: "今日", href: "/opening/today", icon: Sun },
    { title: "卡片", href: "/opening/cards", icon: Layers2 },
    { title: "AI 建议", href: "/opening/suggestions", icon: ClipboardCheck },
    { title: "课程", href: "/opening/courses", icon: Notebook },
    { title: "连接", href: "/opening/settings/connections", icon: Link2 },
  ].map(({ title, href, icon: Icon }) => <Link key={href} href={href} className={ui.quiet}><Icon size={14} aria-hidden="true" />{title}<ArrowUpRight size={12} aria-hidden="true" /></Link>)}</nav>;
}
