import type { ReactNode } from "react";
import { ui } from "../ui/controls";
import { TransitionLink } from "../motion/view-transition";
import { TopBar } from "../shell/top-bar";

export type SummaryCounts = { independent: number; assisted: number; needsWork: number; unverified: number };

type SessionSummaryProps = {
  title: string;
  /** 由学习服务汇总；前端不自行判定掌握 */
  counts: SummaryCounts;
  learned: string[];
  needsHelp: { label: string; href: string }[];
  /** 复习安排由复习服务给出，这里只呈现 */
  next: { label: string; when?: string; href: string };
  backHref: string;
  extra?: ReactNode;
};

const STAT: { key: keyof SummaryCounts; label: string; tone: string }[] = [
  { key: "independent", label: "独立完成", tone: "text-accent" },
  { key: "assisted", label: "提示后完成", tone: "text-text" },
  { key: "needsWork", label: "还要再练", tone: "text-warn" },
  { key: "unverified", label: "尚需验证", tone: "text-text-2" },
];

/**
 * T11 本次小结：会了什么、哪里还需要帮助、下次做什么。
 * 学习进度、独立表现、延迟验证分开表达；数据不足写「尚需验证」，不写成「不会」。
 */
export function SessionSummary({ title, counts, learned, needsHelp, next, backHref, extra }: SessionSummaryProps) {
  return (
    <div data-scroll-root className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <TopBar title={title} collapsedTitle />
      <div className="content-grid pb-10 pt-2 motion-safe:stagger">
        <header className="space-y-1">
          <p className="text-meta text-text-2">本次小结</p>
          <h1 className="text-display font-semibold">{title}</h1>
        </header>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {STAT.map(stat => (
            <div key={stat.key} className="rounded-tile border border-line bg-surface/80 px-4 py-3">
              <dt className="text-meta text-text-2">{stat.label}</dt>
              <dd className={`text-display font-semibold tabular-nums ${stat.tone}`}><span className="inline-block motion-safe:animate-badge-pop">{counts[stat.key]}</span></dd>
            </div>
          ))}
        </dl>
        {learned.length > 0 && <section className="space-y-2"><h2 className="text-meta font-medium text-text-2">这次弄清楚的</h2><ul className="prose-reading list-disc space-y-1 pl-5 text-ui-lg">{learned.map(item => <li key={item}>{item}</li>)}</ul></section>}
        {needsHelp.length > 0 && <section className="space-y-2"><h2 className="text-meta font-medium text-text-2">还需要帮助</h2>
          <ul className="divide-y divide-line rounded-tile border border-line bg-surface">{needsHelp.map(item => <li key={item.label}><TransitionLink href={item.href} className="flex min-h-(--control-h) items-center justify-between px-4 text-ui text-text hover:bg-surface-2">{item.label}<span aria-hidden="true">→</span></TransitionLink></li>)}</ul></section>}
        <section className="flex flex-wrap items-center gap-2 rounded-panel glass p-4">
          <div className="min-w-0 flex-1"><p className="text-meta text-text-2">下一步</p><p className="text-ui text-text">{next.label}{next.when ? <span className="ml-2 text-meta text-text-2">{next.when}</span> : null}</p></div>
          <TransitionLink href={backHref} direction="back" className={ui.quiet}>回到课程</TransitionLink>
          <TransitionLink href={next.href} direction="forward" className={ui.primary}>开始</TransitionLink>
        </section>
        {extra}
      </div>
    </div>
  );
}
