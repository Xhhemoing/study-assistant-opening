"use client";

import { ShellNavLink } from "./shell-nav-link";
import { navigationIsActive, openingNavigation } from "./navigation";
import { openingNavigationIcons } from "./navigation-icons";

export function OpeningMobileNavigation({ pathname, search = "", dueCount }: { pathname: string; search?: string; pendingCount?: number | null; dueCount?: number | null }) {
  return <nav aria-label="学习工作台导航（移动端）" className="grid grid-cols-4 gap-1 px-2">
    {openingNavigation().filter(item => item.group === "core").map(item => {
      const Icon = openingNavigationIcons[item.icon];
      const active = navigationIsActive(item.href, pathname, search);
      return <ShellNavLink key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${active ? "bg-surface-2 font-semibold text-text" : "text-text-2 hover:bg-surface-2 hover:text-text"}`}><Icon size={20} aria-hidden="true" /><span>{item.label}{item.icon === "review" && dueCount ? ` ${dueCount}` : ""}</span></ShellNavLink>;
    })}
  </nav>;
}
