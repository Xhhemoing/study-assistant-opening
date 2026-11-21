import type { ReactNode } from "react";
import Link from "next/link";

export function AuthFrame({ title, description, titleId, children, footer }: { title: string; description: string; titleId: string; children: ReactNode; footer: ReactNode }) {
  return <main className="flex min-h-dvh items-center justify-center bg-bg px-5 py-10 text-text">
    <section className="w-full max-w-[400px] rounded-panel border border-line bg-surface p-6 shadow-card sm:p-7" aria-labelledby={titleId}>
      <Link className="inline-flex items-center gap-2.5 rounded-lg text-sm font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href="/"><span className="keycap-ink inline-flex size-8 items-center justify-center rounded-lg text-xs" aria-hidden="true">AI</span>AIstudy</Link>
      <header className="mb-6 mt-7"><h1 id={titleId} className="font-serif text-2xl font-semibold tracking-tight text-text">{title}</h1><p className="mt-2 text-sm leading-6 text-text-2">{description}</p></header>
      {children}<div className="mt-6 border-t border-line pt-4 text-xs leading-5 text-text-2">{footer}</div>
    </section>
  </main>;
}
