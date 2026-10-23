"use client";
import { usePathname } from "next/navigation";
import { Suspense, createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { MessageSquare, MoreHorizontal, PanelLeft, Search } from "lucide-react";
import { TransitionLink, ViewTransitionBoundary } from "../motion/view-transition";
import { Sheet } from "../ui/sheet";
import { NAV_CORE, NAV_SYSTEM, NAV_TOOLS, activeNavId, featureHref, type Feature } from "./features";
import { FEATURE_ICONS } from "./icons";
import { NAV_WIDTH_DEFAULT, NAV_WIDTH_MAX, NAV_WIDTH_MIN, clampNavWidth, useLayoutPref } from "./use-layout-pref";
import { HeaderToolsSlot } from "./header-tools-slot";
import { ui } from "../ui/controls";

export type RecentThread = { id: string; title: string; href: string };

/** 生产可覆盖的导航：入口、无障碍名称、激活判定。不传则用功能注册表的默认导航。 */
export type ShellNav = {
  label: string;
  mobileLabel: string;
  core: Feature[];
  tools: Feature[];
  system: Feature[];
  isActive: (item: Feature, pathname: string) => boolean;
};

/** 手机「更多」抽屉底部的全局项（问 AI、账户），由 AppShell 提供给每页的 MobileHeaderTools */
const MobileMenuExtra = createContext<ReactNode>(null);
/** 只有在壳层内才渲染手机工具（独立渲染/测试时没有路由与导航，不输出） */
const InShell = createContext(false);

type AppShellProps = {
  children: ReactNode;
  /** 真实计数（如复习到期），键为功能 id；没有数据就不传，不显示 0 */
  counts?: Partial<Record<string, number>>;
  recent?: RecentThread[];
  /** 导航里「问 AI」等全局入口，放在核心导航之后 */
  navExtra?: ReactNode;
  /** 导航底部账户区（菜单、退出），在设置之后 */
  account?: ReactNode;
  /** 主区顶部全局提示（连接、能力、错误），不占独立页头 */
  banner?: ReactNode;
  /** 专注：隐藏导航与手机底栏 */
  hideNav?: boolean;
  /** 手机「更多」抽屉底部的全局项 */
  mobileMenuExtra?: ReactNode;
  /** 覆盖导航（生产沿用既有入口与无障碍名称） */
  nav?: ShellNav;
  /** 手机底栏末尾（如账户按钮） */
  mobileTrailing?: ReactNode;
  /** 打开全局搜索 / 命令面板（⌘K）；传入时在导航顶部显示搜索按钮 */
  onOpenSearch?: () => void;
};

/**
 * T1 壳层：导航、布局偏好、页面过渡边界。不请求业务数据、不判定掌握度。
 * 外观：根节点带 data-ui="v3" 与皮肤/密度/圆角（tailwind.css 外观层解释，换样式只改那里）。
 * 导航铺在柔和背景上，主区是一张圆角内容页；手机底栏为悬浮玻璃胶囊。
 * 动效：导航宽度 232↔72 过渡；激活底块带 view-transition-name，在入口间滑动；主区参与页面过渡。
 */
export function AppShell({ children, counts = {}, recent = [], navExtra, account, banner, hideNav = false, mobileMenuExtra = null, nav, mobileTrailing, onOpenSearch }: AppShellProps) {
  const pathname = usePathname() ?? "";
  const activeId = activeNavId(pathname);
  const isActive = (item: Feature) => nav ? nav.isActive(item, pathname) : activeId === item.id;
  const [pref, setPref] = useLayoutPref();
  const compact = pref.nav === "compact";
  // 外观属性同时写到 <html>：Radix 弹层、抽屉渲染在 body 下，也要读到外观层变量
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.ui = "v3"; root.dataset.skin = pref.skin; root.dataset.density = pref.density; root.dataset.corner = pref.corner;
    return () => { delete root.dataset.ui; delete root.dataset.skin; delete root.dataset.density; delete root.dataset.corner; };
  }, [pref.skin, pref.density, pref.corner]);
  // 导航宽度是用户拖出来的连续值：写成根元素上的 CSS 变量，导航仍用 w-(--layout-nav)
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const navWidth = dragWidth ?? pref.navWidth;
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--layout-nav", `${navWidth}px`);
    return () => { root.style.removeProperty("--layout-nav"); };
  }, [navWidth]);

  return (
    <InShell.Provider value={true}><MobileMenuExtra.Provider value={mobileMenuExtra}><HeaderToolsSlot.Provider value={<MobileHeaderTools recent={recent} />}>
    <div data-app-shell data-focus={hideNav} data-nav-dragging={dragWidth !== null} data-ui="v3" data-skin={pref.skin} data-density={pref.density} data-corner={pref.corner} className="flex h-dvh text-text app-backdrop">
      <Suspense><ViewTransitionBoundary /></Suspense>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-ctl focus:bg-surface focus:px-3 focus:py-2">跳到主要内容</a>

      <nav id="app-nav" aria-label={nav?.label ?? "主导航"} data-compact={compact} hidden={hideNav}
        className="relative hidden w-(--layout-nav) shrink-0 flex-col overflow-hidden py-3 transition-[width] duration-(--duration-state) ease-standard [view-transition-name:app-nav] data-[compact=true]:w-(--layout-nav-compact) md:flex">
        <button type="button" onClick={() => setPref({ nav: compact ? "expanded" : "compact" })}
          aria-label={compact ? "展开导航" : "收起导航"} aria-expanded={!compact}
          className={`${ui.icon} mx-2.5 mb-2`}>
          <PanelLeft size={18} aria-hidden="true" />
        </button>
        {onOpenSearch ? (
          <div className="mb-2 px-1.5">
            <button type="button" onClick={onOpenSearch} aria-label="打开全局搜索" title="全局搜索与快捷导航 (Ctrl / ⌘ K)"
              className="flex min-h-(--control-h) w-full items-center rounded-pill text-text-2 transition-colors duration-(--duration-micro) hover:bg-text/5 hover:text-text">
              <span className="grid w-11 shrink-0 justify-items-center"><Search size={17} aria-hidden="true" /></span>
              <span data-hidden={compact} className="flex-1 whitespace-nowrap text-left text-ui data-[hidden=true]:sr-only">搜索</span>
              {!compact && <kbd className="mr-3 rounded-ctl border border-line px-1.5 text-cap text-text-2">⌘K</kbd>}
            </button>
          </div>
        ) : null}
        <NavGroup items={nav?.core ?? NAV_CORE} isActive={isActive} compact={compact} counts={counts} />
        {navExtra ? <div className="mt-1 px-1.5">{navExtra}</div> : null}
        <NavGroup items={nav?.tools ?? NAV_TOOLS} isActive={isActive} compact={compact} counts={counts} divided />
        <section aria-label="最近对话" data-hidden={compact || recent.length === 0} inert={compact}
          className="mt-4 min-h-0 flex-1 overflow-y-auto px-2 pt-1 transition-opacity duration-(--duration-state) data-[hidden=true]:pointer-events-none data-[hidden=true]:opacity-0">
          <p className="px-3 pb-1 text-cap text-text-3">最近</p>
          <ul>{recent.slice(0, 8).map(thread => (
            <li key={thread.id}><TransitionLink href={thread.href} className="block truncate whitespace-nowrap rounded-pill px-3 py-1.5 text-meta text-text-2 transition-colors hover:bg-text/5 hover:text-text">{thread.title}</TransitionLink></li>
          ))}</ul>
          {recent.length > 0 && <TransitionLink href={featureHref("assistant")} className="block whitespace-nowrap px-3 py-2 text-meta text-text-2 hover:text-text">全部对话</TransitionLink>}
        </section>
        <div className="mt-auto"><NavGroup items={nav?.system ?? NAV_SYSTEM} isActive={isActive} compact={compact} counts={counts} />{account ? <div className="mt-1 px-1.5">{account}</div> : null}</div>
        {!compact ? <NavResizer width={navWidth} onDrag={setDragWidth} onCommit={width => { setDragWidth(null); setPref({ navWidth: width }); }} /> : null}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <main id="main-content" tabIndex={-1} data-scroll-root data-focus={hideNav} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg [scrollbar-gutter:stable] [view-transition-name:app-main] md:my-2 md:mr-2 md:rounded-panel md:border md:border-line md:shadow-card data-[focus=true]:m-0 data-[focus=true]:rounded-none data-[focus=true]:border-0">
          {banner}
          <div className="flex-1">{children}</div>
        </main>
        {!hideNav && <MobileTabBar items={nav?.core ?? NAV_CORE} label={nav?.mobileLabel ?? "主导航"} isActive={isActive} counts={counts} trailing={mobileTrailing} />}
      </div>
    </div>
    </HeaderToolsSlot.Provider></MobileMenuExtra.Provider></InShell.Provider>
  );
}

function NavGroup({ items, isActive, compact, counts, divided = false }: { items: Feature[]; isActive: (item: Feature) => boolean; compact: boolean; counts: Partial<Record<string, number>>; divided?: boolean }) {
  return (
    <ul className={divided ? "mt-4 space-y-0.5" : "space-y-0.5"}>
      {items.map(item => {
        const Icon = FEATURE_ICONS[item.icon];
        const current = isActive(item);
        const count = counts[item.id];
        return (
          <li key={item.id} className="px-1.5">
            <TransitionLink href={item.route} aria-current={current ? "page" : undefined}
              className="group relative flex min-h-(--control-h) items-center rounded-pill text-text-2 transition-colors duration-(--duration-micro) hover:bg-text/5 hover:text-text aria-[current=page]:font-medium aria-[current=page]:text-text">
              {current && <span aria-hidden="true" className="absolute inset-0 rounded-pill bg-surface shadow-card [view-transition-name:nav-active]" />}
              <span className={`relative grid w-11 shrink-0 justify-items-center ${compact ? "gap-0.5 py-1.5" : ""}`}>
                <Icon size={17} aria-hidden="true" />
                {compact && <span className="text-cap motion-safe:animate-fade-in">{item.label}</span>}
              </span>
              <span data-hidden={compact} className="relative flex-1 whitespace-nowrap text-ui transition-opacity duration-(--duration-micro) data-[hidden=true]:sr-only">{item.label}</span>
              {count ? <span key={count} className={`tabular-nums text-cap text-accent motion-safe:animate-badge-pop ${compact ? "absolute right-2 top-1" : "relative mr-3"}`}>{count}<span className="sr-only">项待完成</span></span> : null}
            </TransitionLink>
          </li>
        );
      })}
    </ul>
  );
}

function MobileTabBar({ items, label, isActive, counts, trailing }: { items: Feature[]; label: string; isActive: (item: Feature) => boolean; counts: Partial<Record<string, number>>; trailing?: ReactNode }) {
  return (
    <div className="mx-3 mb-[calc(8px+env(safe-area-inset-bottom))] mt-1 flex items-center gap-1 rounded-pill glass p-1 [view-transition-name:app-tabbar] md:hidden">
    <nav aria-label={label} className="grid min-w-0 flex-1 grid-flow-col auto-cols-fr">
      {items.map(item => {
        const Icon = FEATURE_ICONS[item.icon];
        const current = isActive(item);
        return (
          <TransitionLink key={item.id} href={item.route} aria-current={current ? "page" : undefined}
            className="relative flex h-12 flex-col items-center justify-center gap-0.5 rounded-pill text-cap text-text-2 transition-transform duration-(--duration-micro) active:scale-95 aria-[current=page]:font-medium aria-[current=page]:text-text">
            {current && <span aria-hidden="true" className="absolute inset-0 rounded-pill bg-surface shadow-card [view-transition-name:tab-active]" />}
            <Icon size={19} aria-hidden="true" className="relative" />
            <span className="relative">{item.label}{counts[item.id] ? ` ${counts[item.id]}` : ""}</span>
          </TransitionLink>
        );
      })}
    </nav>
    {trailing ? <div className="shrink-0 pr-0.5">{trailing}</div> : null}
    </div>
  );
}

/** 手机每页右上：搜索 + 更多（学习工具、最近对话、设置）。 */
/** 首次挂载后才渲染：手机工具依赖客户端路由，服务端/静态渲染时不输出，也避免多余的水合。 */
export function MobileHeaderTools(props: { recent?: RecentThread[] }) {
  const inShell = useContext(InShell);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return inShell && mounted ? <MobileHeaderToolsInner {...props} /> : null;
}

function MobileHeaderToolsInner({ recent = [] }: { recent?: RecentThread[] }) {
  const [open, setOpen] = useState(false);
  const extra = useContext(MobileMenuExtra);
  return (
    <div className="flex items-center gap-1 md:hidden">
      <TransitionLink href={featureHref("search")} aria-label="搜索" className={ui.icon}><Search size={18} aria-hidden="true" /></TransitionLink>
      <button type="button" aria-label="更多" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className={ui.icon}>
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
      <Sheet open={open} onOpenChange={setOpen} title="更多" hideTitle variant="menu">
        <ul className="grid grid-cols-4 gap-1 motion-safe:stagger">
          {[...NAV_TOOLS, ...NAV_SYSTEM].map(item => {
            const Icon = FEATURE_ICONS[item.icon];
            return <li key={item.id}><TransitionLink href={item.route} onClick={() => setOpen(false)} className="flex h-16 flex-col items-center justify-center gap-1 rounded-ctl text-meta text-text-2 hover:bg-surface-2"><Icon size={20} aria-hidden="true" />{item.label}</TransitionLink></li>;
          })}
        </ul>
        {recent.length > 0 && <ul className="mt-2 border-t border-line pt-2">{recent.slice(0, 5).map(thread => (
          <li key={thread.id}><TransitionLink href={thread.href} onClick={() => setOpen(false)} className="flex min-h-(--control-h) items-center gap-2 truncate px-2 text-ui text-text-2"><MessageSquare size={16} aria-hidden="true" />{thread.title}</TransitionLink></li>
        ))}</ul>}
        {extra ? <div className="mt-2 border-t border-line pt-2" onClickCapture={() => setOpen(false)}>{extra}</div> : null}
      </Sheet>
    </div>
  );
}

/**
 * 导航宽度分隔条（WAI-ARIA window splitter）：拖动、←/→（Shift 加大步长）、Home/End、双击恢复默认。
 * 只在桌面展开态出现；收起为图标栏用顶部按钮。
 */
function NavResizer({ width, onDrag, onCommit }: { width: number; onDrag: (width: number | null) => void; onCommit: (width: number) => void }) {
  const start = useRef<{ x: number; width: number; pointerId: number } | null>(null);
  return (
    <div role="separator" aria-orientation="vertical" aria-label="调整导航宽度" aria-controls="app-nav" tabIndex={0}
      aria-valuenow={width} aria-valuemin={NAV_WIDTH_MIN} aria-valuemax={NAV_WIDTH_MAX} aria-valuetext={`${width} 像素`}
      title="拖动调整宽度，双击恢复默认"
      className="group absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize touch-none outline-none"
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); start.current = { x: event.clientX, width, pointerId: event.pointerId }; onDrag(width); }}
      onPointerMove={event => { const from = start.current; if (!from || from.pointerId !== event.pointerId) return; onDrag(clampNavWidth(from.width + event.clientX - from.x)); }}
      onPointerUp={event => { const from = start.current; if (!from || from.pointerId !== event.pointerId) return; start.current = null; onCommit(clampNavWidth(from.width + event.clientX - from.x)); }}
      onPointerCancel={() => { start.current = null; onDrag(null); }}
      onDoubleClick={() => onCommit(NAV_WIDTH_DEFAULT)}
      onKeyDown={event => {
        const step = event.shiftKey ? 24 : 8;
        const next = event.key === "ArrowLeft" ? width - step : event.key === "ArrowRight" ? width + step : event.key === "Home" ? NAV_WIDTH_MIN : event.key === "End" ? NAV_WIDTH_MAX : event.key === "Enter" ? NAV_WIDTH_DEFAULT : null;
        if (next === null) return;
        event.preventDefault(); onCommit(clampNavWidth(next));
      }}>
      <span aria-hidden="true" className="absolute inset-y-3 left-1/2 w-px -translate-x-1/2 rounded-pill bg-transparent transition-colors duration-(--duration-micro) group-hover:bg-line-strong group-focus-visible:bg-accent group-active:bg-accent" />
    </div>
  );
}
