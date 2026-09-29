import { RefreshCw } from "lucide-react";
import { ui } from "../design/ui";

export function EmptyState({ title, description, onRetry }: { title: string; description: string; onRetry?: () => void }) {
  return <section className="border-y border-zinc-200 bg-white px-5 py-8" role={onRetry ? "alert" : undefined}><h2 className="text-sm font-semibold text-zinc-800">{title}</h2><p className="mt-2 text-sm leading-7 text-zinc-500">{description}</p>{onRetry ? <button className={`${ui.secondary} mt-4`} onClick={onRetry} type="button"><RefreshCw aria-hidden="true" size={14} />重试</button> : null}</section>;
}
