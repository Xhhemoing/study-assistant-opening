import { RefreshCw } from "lucide-react";

/** Explains an unavailable or empty opening section with a safe next action. */
export function EmptyState({ title, description, onRetry }: { title: string; description: string; onRetry?: () => void }) {
  return (
    <section className="rounded-xl border border-dashed border-zinc-300 bg-white p-6" role={onRetry ? "alert" : undefined}>
      <h2 className="text-lg font-semibold text-zinc-900">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-600">{description}</p>
      {onRetry ? (
        <button className="mt-5 inline-flex min-h-10 items-center gap-2 rounded-md border border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" onClick={onRetry} type="button">
          <RefreshCw aria-hidden="true" size={16} />
          重试
        </button>
      ) : null}
    </section>
  );
}
