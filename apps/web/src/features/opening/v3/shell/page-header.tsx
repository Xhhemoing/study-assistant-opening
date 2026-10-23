import type { ReactNode } from "react";
import { TransitionLink } from "../motion/view-transition";
import { TopBar } from "./top-bar";
import { ShellHeaderTools } from "./header-tools-slot";

/**
 * 页头 = 顶栏：标题直接放在顶栏左侧、贴近顶部与左缘，不再单独占一块大标题区，把面积留给核心内容。
 * 一行：h1 + 可选一行事实 + 一个主操作 + 工具。滚动后顶栏变玻璃。
 * 有意不提供长 description：必要说明放在相关内容旁。
 * 页面切换时标题平滑过渡到新标题；从带 vtSource 的列表行进入时，标题从那一行「飞」过来（共享元素）。
 */
export function PageHeader({ title, fact, action, tools = <ShellHeaderTools />, sharedTitle = false, label }: { title: ReactNode; label?: string; fact?: ReactNode; action?: ReactNode; tools?: ReactNode; sharedTitle?: boolean }) {
  return (
    <TopBar label={label ?? (typeof title === "string" || typeof title === "number" ? `${title} 顶栏` : "页面顶栏")}
      title={
        <div className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-3">
          <h1 data-page-title={sharedTitle ? "shared" : "page"} className="truncate text-title font-semibold tracking-[-0.01em] text-text">{title}</h1>
          {fact ? <p className="truncate text-meta text-text-2">{fact}</p> : null}
        </div>
      }
      actions={<>{action}{tools}</>} />
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
      <div className="content-grid pb-10 pt-3">{children}</div>
    </div>
  );
}
