import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { TransitionLink } from "../motion/view-transition";
import { motion } from "../motion";

/** 列表分组：可选小标题 + 进入时错开出现。所有列表页、课程分区、复习、搜索结果共用。 */
export function ListSection({ title, children, framed = false, ordered = false }: { title?: string; children: ReactNode; framed?: boolean; ordered?: boolean }) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <section aria-label={title}>
      {title ? <h2 className="mb-2 text-[13px] font-medium text-text-2">{title}</h2> : null}
      <Tag className={`${motion.stagger} divide-y divide-line ${framed ? "overflow-hidden rounded-card border border-line bg-surface" : ""}`}>{children}</Tag>
    </section>
  );
}

type ListRowProps = {
  href?: string;
  title: ReactNode;
  meta?: ReactNode;
  /** 右侧：状态、时长、计数 */
  trailing?: ReactNode;
  leading?: ReactNode;
  /** 点击后目标页标题承接本行标题 */
  sharedTitle?: boolean;
  framed?: boolean;
  /** 新出现的行（如应用计划后新增）短暂高亮一次 */
  highlight?: boolean;
};

/** 统一列表行：最小 56px 高、标题 + 一行说明、右侧状态；有 href 时整行可点。 */
export function ListRow({ href, title, meta, trailing, leading, sharedTitle = false, framed = false, highlight = false }: ListRowProps) {
  const body = <>
    {leading}
    <span className="min-w-0 flex-1">
      <span data-vt-title className="block truncate text-[15px] text-text">{title}</span>
      {meta ? <span className="block truncate text-[13px] text-text-2">{meta}</span> : null}
    </span>
    {trailing ? <span className="shrink-0 text-[13px] tabular-nums text-text-2">{trailing}</span> : null}
    {href ? <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-text-3 transition-transform duration-(--duration-micro) ease-standard group-hover:translate-x-0.5" /> : null}
  </>;
  const cls = `group flex min-h-14 items-center gap-3 py-2 ${framed ? "px-4" : ""} ${highlight ? motion.settle : ""}`;
  return (
    <li>
      {href
        ? <TransitionLink href={href} vtSource={sharedTitle ? "object-title" : undefined} className={`${cls} ${motion.colors} hover:bg-surface-2/60 rounded-sm`}>{body}</TransitionLink>
        : <div className={cls}>{body}</div>}
    </li>
  );
}
