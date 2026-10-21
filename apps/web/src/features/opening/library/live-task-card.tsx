import type { ReactNode } from "react";
import { FileText, TriangleAlert } from "lucide-react";

/** Only byte transfer provides a numeric progress value. Parsing exposes stages. */
export function LiveTaskCard({ title, phase, byteProgress, failed = false, children }: {
  title: string;
  phase: string;
  byteProgress?: number;
  failed?: boolean;
  children?: ReactNode;
}) {
  const percent = byteProgress === undefined ? null : Math.min(100, Math.max(0, Math.round(byteProgress)));
  return <article aria-label={`处理材料：${title}`} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
    <div className="flex items-start gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text-2"><FileText size={17} aria-hidden="true" /></span><div className="min-w-0 flex-1"><h3 className="break-words text-sm font-medium text-text">{title}</h3><p role="status" className={`mt-1 flex items-center gap-1.5 text-xs leading-5 ${failed ? "text-danger" : "text-text-2"}`}>{failed ? <TriangleAlert size={13} aria-hidden="true" /> : null}{phase}</p></div>{percent !== null ? <span className="text-xs tabular-nums text-text-3">{percent}%</span> : null}</div>
    {percent !== null ? <progress aria-label={`${title} 已传输字节`} max={100} value={percent} className="mt-3 h-1.5 w-full appearance-none overflow-hidden rounded-full accent-ai-1 [&::-webkit-progress-bar]:bg-surface-2 [&::-webkit-progress-value]:bg-linear-to-r [&::-webkit-progress-value]:from-ai-1 [&::-webkit-progress-value]:via-ai-2 [&::-webkit-progress-value]:to-ai-3 [&::-moz-progress-bar]:bg-linear-to-r [&::-moz-progress-bar]:from-ai-1 [&::-moz-progress-bar]:via-ai-2 [&::-moz-progress-bar]:to-ai-3" /> : !failed ? <div aria-hidden="true" className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2"><span className="absolute inset-0 bg-linear-to-r from-ai-1/40 via-ai-2/50 to-ai-3/40 motion-safe:animate-shimmer" /></div> : null}
    {children ? <div className="mt-3 flex flex-wrap gap-2">{children}</div> : null}
  </article>;
}
