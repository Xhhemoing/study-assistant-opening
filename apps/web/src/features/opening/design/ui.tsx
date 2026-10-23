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
export function PageHeading({ title, description, action, actions }: { title: ReactNode; description?: ReactNode; action?: ReactNode; actions?: ReactNode }) {
  // 文字说明不再陈列（v4 降噪）：只保留结构化事实（日期、计数等非纯文本节点）。
  const fact = typeof description === "string" ? undefined : description;
  return <V3PageHeader title={title} fact={fact} action={action ?? actions} />;
}
/** New pages keep explanations beside the relevant content, never in a second heading row. */
export function PageHeader({ title, action, actions }: { title: ReactNode; action?: ReactNode; actions?: ReactNode }) {
  return <PageHeading title={title} action={action ?? actions} />;
}

/** The workspace itself stays full width. Only individual content blocks have a reading measure. */
export function ContentGrid({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`w-full min-w-0 space-y-6 ${className}`}>{children}</div>;
}

export function ContentBlock({ children, width = "prose", className = "" }: { children: ReactNode; width?: "prose" | "wide" | "full"; className?: string }) {
  const measure = { prose: "max-w-[680px]", wide: "max-w-[1040px]", full: "max-w-none" }[width];
  return <div data-content-width={width} className={`mx-auto w-full min-w-0 ${measure} ${className}`}>{children}</div>;
}
export function EntryLinks() {
  return <nav aria-label="学习闭环入口" className="flex flex-wrap gap-1">{[
    { title: "今日", href: "/opening/today", icon: Sun },
    { title: "卡片", href: "/opening/cards", icon: Layers2 },
    { title: "AI 建议", href: "/opening/suggestions", icon: ClipboardCheck },
    { title: "课程", href: "/opening/courses", icon: Notebook },
    { title: "连接", href: "/opening/settings/connections", icon: Link2 },
  ].map(({ title, href, icon: Icon }) => <Link key={href} href={href} className={ui.quiet}><Icon size={14} aria-hidden="true" />{title}<ArrowUpRight size={12} aria-hidden="true" /></Link>)}</nav>;
}
