import type { ReactNode } from "react";
import { TransitionLink } from "../motion/view-transition";
import { TopBar } from "./top-bar";

/**
 * 页头：大标题在内容里，顶栏只在大标题滚出后显示小标题（iOS 式）。
 * h1 + 可选一行事实 + 一个主操作 + 手机工具。有意不提供 description：必要说明放在相关内容旁。
 * sharedTitle 时标题承接来源行（共享元素过渡）。必须放在 ListPage 内。
 */
export function PageHeader({ title, fact, action, tools, sharedTitle = false }: { title: string; fact?: ReactNode; action?: ReactNode; tools?: ReactNode; sharedTitle?: boolean }) {
  return (
    <>
      <TopBar title={title} collapsedTitle actions={tools} />
      <div className="content-grid pb-2 pt-1">
        <div className="col-wide flex flex-wrap items-end gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <h1 className={`truncate text-display font-semibold tracking-[-0.01em] text-text ${sharedTitle ? "[view-transition-name:object-title]" : ""}`}>{title}</h1>
            {fact ? <p className="mt-0.5 truncate text-meta text-text-2">{fact}</p> : null}
          </div>
          {action}
        </div>
      </div>
    </>
  );
}

export type LocationSegment = { label: string; href?: string };

/** 一行位置：课程 · 单元 · 题号/页码。专注态也保留。 */
export function LocationLine({ segments }: { segments: LocationSegment[] }) {
  return (
    <nav aria-label="当前位置" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-meta text-text-2">
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

/** 列表类页面框架（T6）：一个滚动区，顶栏粘顶，内容从顶栏下穿过（玻璃）。 */
export function ListPage({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div data-scroll-root className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      {header}
      <div className="content-grid pb-10 pt-4">{children}</div>
    </div>
  );
}
