"use client";
import { usePathname } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { MessageSquare, MoreHorizontal, PanelLeft, Search } from "lucide-react";
import { TransitionLink, ViewTransitionBoundary } from "../motion/view-transition";
import { Sheet } from "../ui/sheet";
import { NAV_CORE, NAV_SYSTEM, NAV_TOOLS, activeNavId, featureHref, type Feature } from "./features";
import { FEATURE_ICONS } from "./icons";
import { useLayoutPref } from "./use-layout-pref";

export type RecentThread = { id: string; title: string; href: string };

type AppShellProps = {
  children: ReactNode;
  /** 真实计数（如复习到期），键为功能 id；没有数据就不传，不显示 0 */
  counts?: Partial<Record<string, number>>;
  recent?: RecentThread[];
};

/**
 * T1 壳层：导航、布局偏好、页面过渡边界。不请求业务数据、不判定掌握度。
 * 动效：导航宽度 232↔72 过渡；激活底色带 view-transition-name，在入口间滑动；主区参与页面过渡。
 */
export function AppShell({ children, counts = {}, recent = [] }: AppShellProps) {
  const pathname = usePathname() ?? "";
  const active = activeNavId(pathname);
  const [pref, setPref] = useLayoutPref();
  const compact = pref.nav === "compact";

  return (
    <div className="flex h-dvh bg-bg text-text">
      <Suspense><ViewTransitionBoundary /></Suspense>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-sm focus:bg-surface focus:px-3 focus:py-2">跳到主要内容</a>

      <nav aria-label="主导航" data-compact={compact}
        className="hidden w-(--layout-nav) shrink-0 flex-col overflow-hidden border-r border-line bg-bg py-3 transition-[width] duration-(--duration-state) ease-standard [view-transition-name:app-nav] data-[compact=true]:w-(--layout-nav-compact) md:flex">
        <button type="button" onClick={() => setPref({ nav: compact ? "expanded" : "compact" })}
          aria-label={compact ? "展开导航" : "收起导航"} aria-expanded={!compact}
          className="mx-3.5 mb-2 grid size-11 place-items-center rounded-md text-text-2 transition-colors duration-(--duration-micro) hover:bg-surface-2 hover:text-text">
          <PanelLeft size={18} aria-hidden="true" />
        </button>
        <NavGroup items={NAV_CORE} active={active} compact={compact} counts={counts} />
        <NavGroup items={NAV_TOOLS} active={active} compact={compact} counts={counts} divided />
        <section aria-label="最近对话" data-hidden={compact || recent.length === 0} inert={compact}
          className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-line px-2 pt-3 transition-opacity duration-(--duration-state) data-[hidden=true]:pointer-events-none data-[hidden=true]:opacity-0">
          <ul>{recent.slice(0, 8).map(thread => (
            <li key={thread.id}><TransitionLink href={thread.href} className="block truncate whitespace-nowrap rounded-md px-3 py-2 text-[13px] text-text-2 transition-colors hover:bg-surface-2 hover:text-text">{thread.title}</TransitionLink></li>
          ))}</ul>
          {recent.length > 0 && <TransitionLink href={featureHref("assistant")} className="block whitespace-nowrap px-3 py-2 text-[13px] text-text-2 hover:text-text">全部对话</TransitionLink>}
        </section>
        <div className="mt-auto"><NavGroup items={NAV_SYSTEM} active={active} compact={compact} counts={counts} /></div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <main id="main" className="min-h-0 flex-1 [view-transition-name:app-main]">{children}</main>
        <MobileTabBar active={active} counts={counts} />
      </div>
    </div>
  );
}

function NavGroup({ items, active, compact, counts, divided = false }: { items: Feature[]; active: string | null; compact: boolean; counts: Partial<Record<string, number>>; divided?: boolean }) {
  return (
    <ul className={divided ? "mt-3 border-t border-line pt-3" : ""}>
      {items.map(item => {
        const Icon = FEATURE_ICONS[item.icon];
        const current = active === item.id;
        const count = counts[item.id];
        return (
          <li key={item.id} className="px-2">
            <TransitionLink href={item.route} aria-current={current ? "page" : undefined}
              className="relative flex min-h-11 items-center rounded-md text-text-2 transition-colors duration-(--duration-micro) hover:text-text aria-[current=page]:font-medium aria-[current=page]:text-text">
              {current && <span aria-hidden="true" className="absolute inset-0 rounded-md bg-surface-2 [view-transition-name:nav-active]" />}
              <span className={`relative grid w-14 shrink-0 justify-items-center ${compact ? "gap-0.5 py-1.5" : ""}`}>
                <Icon size={18} aria-hidden="true" />
                {compact && <span className="text-[12px] leading-4 motion-safe:animate-fade-in">{item.label}</span>}
              </span>
              <span data-hidden={compact} className="relative flex-1 whitespace-nowrap text-[15px] transition-opacity duration-(--duration-micro) data-[hidden=true]:sr-only">{item.label}</span>
              {count ? <span key={count} className={`tabular-nums text-[12px] text-accent motion-safe:animate-badge-pop ${compact ? "absolute right-2 top-1" : "relative mr-3"}`}>{count}<span className="sr-only">项待完成</span></span> : null}
            </TransitionLink>
          </li>
        );
      })}
    </ul>
  );
}

function MobileTabBar({ active, counts }: { active: string | null; counts: Partial<Record<string, number>> }) {
  return (
    <nav aria-label="主导航" className="grid grid-cols-4 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] [view-transition-name:app-tabbar] md:hidden">
      {NAV_CORE.map(item => {
        const Icon = FEATURE_ICONS[item.icon];
        const current = active === item.id;
        return (
          <TransitionLink key={item.id} href={item.route} aria-current={current ? "page" : undefined}
            className="relative flex h-14 flex-col items-center justify-center gap-0.5 text-[12px] text-text-2 active:scale-95 transition-transform duration-(--duration-micro) aria-[current=page]:text-text">
            {current && <span aria-hidden="true" className="absolute top-0 h-0.5 w-8 rounded-pill bg-ink [view-transition-name:tab-active]" />}
            <Icon size={20} aria-hidden="true" />
            <span>{item.label}{counts[item.id] ? ` ${counts[item.id]}` : ""}</span>
          </TransitionLink>
        );
      })}
    </nav>
  );
}

/** 手机每页右上：搜索 + 更多（学习工具、最近对话、设置）。 */
export function MobileHeaderTools({ recent = [] }: { recent?: RecentThread[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-1 md:hidden">
      <TransitionLink href={featureHref("search")} aria-label="搜索" className="grid size-11 place-items-center rounded-md text-text-2"><Search size={20} aria-hidden="true" /></TransitionLink>
      <button type="button" aria-label="更多" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className="grid size-11 place-items-center rounded-md text-text-2">
        <MoreHorizontal size={20} aria-hidden="true" />
      </button>
      <Sheet open={open} onOpenChange={setOpen} title="更多" hideTitle variant="menu">
        <ul className="grid grid-cols-4 gap-1 motion-safe:stagger">
          {[...NAV_TOOLS, ...NAV_SYSTEM].map(item => {
            const Icon = FEATURE_ICONS[item.icon];
            return <li key={item.id}><TransitionLink href={item.route} onClick={() => setOpen(false)} className="flex h-16 flex-col items-center justify-center gap-1 rounded-md text-[13px] text-text-2 hover:bg-surface-2"><Icon size={20} aria-hidden="true" />{item.label}</TransitionLink></li>;
          })}
        </ul>
        {recent.length > 0 && <ul className="mt-2 border-t border-line pt-2">{recent.slice(0, 5).map(thread => (
          <li key={thread.id}><TransitionLink href={thread.href} onClick={() => setOpen(false)} className="flex min-h-11 items-center gap-2 truncate px-2 text-[15px] text-text-2"><MessageSquare size={16} aria-hidden="true" />{thread.title}</TransitionLink></li>
        ))}</ul>}
      </Sheet>
    </div>
  );
}
