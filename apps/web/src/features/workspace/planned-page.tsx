import { ArrowLeft, Route } from "lucide-react";
import Link from "next/link";

export function PlannedPage({ title, description }: { title: string; description: string }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <header className="space-y-3 border-b border-line pb-6">
        <Link className="inline-flex items-center gap-2 text-sm text-text-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn"><ArrowLeft aria-hidden="true" size={16} />返回学习空间</Link>
        <div className="flex items-start gap-3"><Route aria-hidden="true" className="mt-1 text-primary" size={20} /><div><p className="text-xs text-text-dim">学习空间</p><div className="mt-1 flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold tracking-[-0.02em] text-text">{title}</h1><span className="rounded-full bg-surface-2 px-2 py-1 text-[11px] font-semibold text-text-dim">规划中</span></div></div></div>
      </header>
      <section className="space-y-3 border-y border-line py-8"><h2 className="text-base font-semibold text-text">入口已接通</h2><p className="max-w-prose text-sm leading-6 text-text-dim">{description}</p><p className="text-sm text-text-dim">当前可以先从今日计划、自由探索或知识库继续。</p><div className="flex flex-wrap gap-3"><Link className="inline-flex min-h-10 items-center rounded-md bg-primary px-3 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn">今日计划</Link><Link className="inline-flex min-h-10 items-center rounded-md border border-line px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/explore">自由探索</Link></div></section>
    </main>
  );
}
