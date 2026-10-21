import { RefreshCw } from "lucide-react";
import { ui } from "../design/ui";

export function EmptyState({ title, description, onRetry }: { title: string; description: string; onRetry?: () => void }) {
  return <section className="border-y border-line bg-surface px-5 py-8" role={onRetry ? "alert" : undefined}><h2 className="text-sm font-semibold text-text">{title}</h2><p className="mt-2 text-sm leading-7 text-text-3">{description}</p>{onRetry ? <button className={`${ui.secondary} mt-4`} onClick={onRetry} type="button"><RefreshCw aria-hidden="true" size={14} />重试</button> : null}</section>;
}
