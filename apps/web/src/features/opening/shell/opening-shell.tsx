"use client";

import { BookOpen, Camera, MessageCircle, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { openingNavigation } from "./navigation";

/** Renders the responsive navigation frame for the opening experience. */
export function OpeningShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const items = openingNavigation();
  const currentCourse = pathname.match(/^\/opening\/courses\/([^/]+)/)?.[1];
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-950">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-zinc-200 bg-white p-6 lg:block">
        <Link className="text-lg font-semibold" href="/opening/today">AIstudy</Link>
        <nav aria-label="Opening navigation" className="mt-10 space-y-2">
          {items.map((item) => <NavigationLink item={item} pathname={pathname} key={item.href} />)}
        </nav>
        <CaptureLink />
      </aside>
      <div className="pb-20 lg:ml-64 lg:pb-0">
        <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-4 lg:px-8">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Opening</p>
            {currentCourse ? (
              <p className="mt-1 text-sm text-zinc-700">当前课程：{currentCourse}</p>
            ) : null}
          </div>
          <CaptureLink />
        </header>
        <main className="mx-auto w-full max-w-5xl p-4 lg:p-8">{children}</main>
      </div>
      <nav aria-label="Opening navigation" className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-3 border-t border-zinc-200 bg-white lg:hidden">
        {items.map((item) => <NavigationLink item={item} pathname={pathname} key={item.href} />)}
      </nav>
    </div>
  );
}

function NavigationLink({ item, pathname }: { item: ReturnType<typeof openingNavigation>[number]; pathname: string }) {
  const active = pathname === item.href || (item.href === "/opening/courses" && pathname.startsWith("/opening/courses/"));
  const Icon = item.href.endsWith("today") ? Sun : item.href.endsWith("assistant") ? MessageCircle : BookOpen;
  return (
    <Link aria-current={active ? "page" : undefined} className="flex min-h-14 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium text-zinc-600 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 lg:justify-start" href={item.href}>
      <Icon aria-hidden="true" size={18} />
      {item.label}
    </Link>
  );
}

function CaptureLink() {
  return (
    <Link className="mt-8 flex min-h-11 items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" href="/opening/assistant">
      <Camera aria-hidden="true" size={17} />
      上传材料
    </Link>
  );
}
