import type { ReactNode } from "react";

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <section className="flex min-h-40 flex-col items-start justify-center gap-2 border-t border-zinc-200 py-8" aria-label={title}>
      <h2 className="text-sm font-semibold text-zinc-800">{title}</h2>
      {description ? <p className="max-w-prose text-sm leading-7 text-zinc-500">{description}</p> : null}
      {action ? <div className="pt-2">{action}</div> : null}
    </section>
  );
}
