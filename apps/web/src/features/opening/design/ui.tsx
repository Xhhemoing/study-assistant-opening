import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, ClipboardCheck, Layers2, Link2, Notebook, Sun } from "lucide-react";

import { ui, fieldClass } from "@aistudy/ui";
import { PageHeader as V3PageHeader } from "../v3/shell/page-header";
export { ui, tone, EmptyState, Skeleton, LoadingRows } from "@aistudy/ui";
export { ErrorState as LoadError, ErrorState as ErrorNotice } from "@aistudy/ui";

export const buttonClass = ui.primary;
export const secondaryButtonClass = ui.secondary;
export const inputClass = ui.input;
export const selectClass = ui.input;
export const textareaClass = `${fieldClass} min-h-24 resize-y text-sm leading-7`;
export const panelClass = ui.panel;
/**
 * 旧页面统一页头：直接使用 v3 PageHeader（标题在顶栏左上、滚动后玻璃），
 * description 作为一行事实显示；手机自动带搜索/更多。
 */
export function PageHeading({ title, description, action, actions }: { title: string; description?: ReactNode; action?: ReactNode; actions?: ReactNode }) {
  const long = typeof description === "string" && description.length > 36;
  return <>
    <V3PageHeader title={title} fact={long ? undefined : description} action={action ?? actions} />
    {long ? <p className="max-w-3xl px-4 pb-1 text-xs leading-5 text-text-2 md:px-6">{description}</p> : null}
  </>;
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
