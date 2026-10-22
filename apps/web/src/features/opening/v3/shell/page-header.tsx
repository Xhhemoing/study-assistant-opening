import type { ReactNode } from "react";
import { TransitionLink } from "../motion/view-transition";

/**
 * 一行页头：h1 + 可选一行事实 + 一个主操作 + 手机工具。
 * 有意不提供 description：必要说明放在相关内容旁。sharedTitle 时标题承接来源行（共享元素过渡）。
 */
export function PageHeader({ title, fact, action, tools, sharedTitle = false }: { title: string; fact?: ReactNode; action?: ReactNode; tools?: ReactNode; sharedTitle?: boolean }) {
  return (
    <header className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-1.5 md:px-8">
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <h1 className={`truncate text-[20px] font-semibold leading-7 text-text ${sharedTitle ? "[view-transition-name:object-title]" : ""}`}>{title}</h1>
        {fact ? <p className="truncate text-[13px] text-text-2">{fact}</p> : null}
      </div>
      {action}
      {tools}
    </header>
  );
}

export type LocationSegment = { label: string; href?: string };

/** 一行位置：课程 · 单元 · 题号/页码。专注态也保留。 */
export function LocationLine({ segments }: { segments: LocationSegment[] }) {
  return (
    <nav aria-label="当前位置" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-[13px] text-text-2">
        {segments.map((segment, index) => {
          const last = index === segments.length - 1;
          return (
            <li key={`${index}-${segment.label}`} className={`flex min-w-0 items-center gap-1.5 ${last ? "font-medium text-text" : "hidden sm:flex"}`}>
              {index > 0 && <span aria-hidden="true" className={`text-text-3 ${last ? "hidden sm:inline" : ""}`}>·</span>}
              {segment.href && !last
                ? <TransitionLink href={segment.href} direction="back" className="truncate hover:text-text">{segment.label}</TransitionLink>
                : <span className="truncate" aria-current={last ? "location" : undefined}>{segment.label}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** 列表类页面框架（T6）：页头 + 滚动区 + content-grid。 */
export function ListPage({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto py-6"><div className="content-grid">{children}</div></div>
    </div>
  );
}
