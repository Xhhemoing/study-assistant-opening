import type { ReactNode } from "react";
import Link from "next/link";

export function AuthFrame({ title, description, titleId, children, footer }: { title: string; description: string; titleId: string; children: ReactNode; footer: ReactNode }) {
  return <main className="flex min-h-dvh items-center justify-center bg-zinc-50 px-5 py-10">
    <section className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6" aria-labelledby={titleId}>
      <Link className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" href="/"><span className="inline-flex size-8 items-center justify-center rounded-md bg-zinc-900 text-[10px] text-white" aria-hidden="true">AI</span>AIstudy</Link>
      <header className="mb-6 mt-8"><h1 id={titleId} className="text-xl font-semibold tracking-tight text-zinc-900">{title}</h1><p className="mt-2 text-sm leading-7 text-zinc-500">{description}</p></header>
      {children}<div className="mt-6 border-t border-zinc-200 pt-4 text-xs text-zinc-500">{footer}</div>
    </section>
  </main>;
}
