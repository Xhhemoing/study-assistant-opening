"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 顶栏（所有页面共用）：
 * - 粘在滚动区顶部；在页面顶部时透明无边，内容滚到下面时变为玻璃并出现细线（data-scrolled）。
 * - 左：返回 / 位置；中：标题（大标题滚出后才淡入，iOS 式）；右：玻璃胶囊工具组。
 * - 进度条贴底，宽度随真实进度变化。
 * 必须放在带 data-scroll-root 的滚动容器内的第一个位置。
 */
type TopBarProps = {
  leading?: ReactNode;
  /** 小标题：传 collapsedTitle 时只在大标题滚出后出现 */
  title?: ReactNode;
  collapsedTitle?: boolean;
  actions?: ReactNode;
  /** 贴底进度条 */
  progress?: ReactNode;
  label?: string;
};

export function TopBar({ leading, title, collapsedTitle = false, actions, progress, label = "页面顶栏" }: TopBarProps) {
  const ref = useRef<HTMLElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const root = ref.current?.closest<HTMLElement>("[data-scroll-root]");
    if (!root) return;
    const sync = () => setScrolled(root.scrollTop > 4);
    sync();
    root.addEventListener("scroll", sync, { passive: true });
    return () => root.removeEventListener("scroll", sync);
  }, []);
  const showTitle = !collapsedTitle || scrolled;
  return (
    <header ref={ref} aria-label={label} data-scrolled={scrolled}
      className="glass-bar sticky top-0 z-20 flex h-(--topbar-h) shrink-0 items-center gap-1.5 px-2 md:px-4">
      {leading}
      <div className="min-w-0 flex-1 px-1">
        {title && <div aria-hidden={collapsedTitle || undefined} data-show={showTitle}
          className="truncate text-ui font-medium text-text transition-[opacity,transform,filter] duration-(--duration-enter) ease-out-expo data-[show=false]:translate-y-1 data-[show=false]:opacity-0 data-[show=false]:blur-[2px]">{title}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      {progress && <div className="absolute inset-x-0 bottom-0">{progress}</div>}
    </header>
  );
}

/** 顶栏右侧工具组：玻璃胶囊。子元素用 ui.iconSm / ui.toolbarButton。 */
export function TopBarTools({ children, label = "页面工具" }: { children: ReactNode; label?: string }) {
  return <div role="toolbar" aria-label={label} className="flex items-center gap-0.5 rounded-pill glass p-0.5">{children}</div>;
}
