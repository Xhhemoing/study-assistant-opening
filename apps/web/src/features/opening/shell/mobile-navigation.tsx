"use client";

import { ClipboardCheck, Layers2, Library, Link2, MessageCircle, MoreHorizontal, Notebook, Sun, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ui } from "../design/ui";
import { navigationIsActive, openingNavigation } from "./navigation";

const icons = { today: Sun, assistant: MessageCircle, library: Library, courses: Notebook, cards: Layers2, review: ClipboardCheck, connections: Link2 };
const mobileLink = "flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-[10px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50";
const activeClass = "bg-emerald-50 font-semibold text-emerald-900";
const inactiveClass = "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900";

export function OpeningMobileNavigation({ pathname, pendingCount }: { pathname: string; pendingCount: number | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const items = openingNavigation();
  const moreItems = items.filter(item => item.group === "more");
  const moreActive = moreItems.some(item => navigationIsActive(item.href, pathname));

  function closeMore() { dialog.current?.close(); setMoreOpen(false); }

  useEffect(() => {
    dialog.current?.close();
    setMoreOpen(false);
  }, [pathname]);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeOnDesktop = () => {
      if (desktop.matches) { dialog.current?.close(); setMoreOpen(false); }
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  return <>
    <nav aria-label="学习工作台导航（移动端）" className="grid grid-cols-5 gap-1 px-2">
      {items.filter(item => item.group === "core").map(item => {
        const Icon = icons[item.icon];
        const active = navigationIsActive(item.href, pathname);
        return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={`${mobileLink} ${active ? activeClass : inactiveClass}`}><Icon size={18} aria-hidden="true" /><span>{item.label}</span></Link>;
      })}
      <button type="button" className={`${mobileLink} ${moreActive ? activeClass : inactiveClass}`} aria-haspopup="dialog" aria-controls="opening-mobile-more" aria-expanded={moreOpen} aria-current={moreActive ? "page" : undefined} onClick={() => { if (!dialog.current?.open) dialog.current?.showModal(); setMoreOpen(true); }}><MoreHorizontal size={18} aria-hidden="true" /><span>更多</span></button>
    </nav>
    <dialog ref={dialog} id="opening-mobile-more" aria-labelledby="opening-mobile-more-title" className="fixed inset-x-4 bottom-20 top-auto m-0 mx-auto max-h-[calc(100dvh_-_6rem)] w-[calc(100%_-_2rem)] max-w-sm overflow-y-auto rounded-xl border border-zinc-200 bg-white p-0 text-zinc-800 shadow-xl backdrop:bg-zinc-950/30" onCancel={event => { event.preventDefault(); closeMore(); }} onClose={() => setMoreOpen(false)} onClick={event => { if (event.target === event.currentTarget) closeMore(); }}>
      <div className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3"><h2 id="opening-mobile-more-title" className="text-sm font-semibold">更多学习工具</h2><button className={ui.icon} type="button" aria-label="关闭更多学习工具" onClick={closeMore}><X size={16} aria-hidden="true" /></button></div>
        <nav aria-label="更多学习工具" className="space-y-1">{moreItems.map(item => {
          const Icon = icons[item.icon];
          const active = navigationIsActive(item.href, pathname);
          return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} onClick={closeMore} className={`flex min-h-12 items-center gap-3 rounded-lg px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50 ${active ? activeClass : inactiveClass}`}><Icon size={18} aria-hidden="true" /><span className="flex-1">{item.label}</span>{item.icon === "review" && pendingCount !== null && pendingCount > 0 ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900" aria-label={`${pendingCount} 项待审核`}>{pendingCount}</span> : null}</Link>;
        })}</nav>
      </div>
    </dialog>
  </>;
}
