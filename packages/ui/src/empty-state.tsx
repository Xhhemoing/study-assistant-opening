import type { ReactNode } from "react";

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <section className="flex min-h-40 flex-col items-start justify-center gap-2 border-t border-line py-8" aria-label={title}>
      <h2 className="text-base font-semibold text-text">{title}</h2>
      {description ? <p className="max-w-prose text-sm text-text-dim">{description}</p> : null}
      {action ? <div className="pt-2">{action}</div> : null}
    </section>
  );
}
