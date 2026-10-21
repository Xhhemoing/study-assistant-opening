"use client";

import { Layers2, Library, Notebook, Sun } from "lucide-react";
import { ShellNavLink } from "./shell-nav-link";
import { navigationIsActive, openingNavigation } from "./navigation";

const icons = { today: Sun, library: Library, courses: Notebook, review: Layers2 };

export function OpeningMobileNavigation({ pathname }: { pathname: string; pendingCount?: number | null }) {
  return <nav aria-label="学习工作台导航（移动端）" className="grid grid-cols-4 gap-1 px-2">
    {openingNavigation().map(item => {
      const Icon = icons[item.icon];
      const active = navigationIsActive(item.href, pathname);
      return <ShellNavLink key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={`flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active ? "bg-accent-soft font-semibold text-accent" : "text-text-2 hover:bg-surface-2 hover:text-text"}`}><Icon size={18} aria-hidden="true" /><span>{item.label}</span></ShellNavLink>;
    })}
  </nav>;
}
