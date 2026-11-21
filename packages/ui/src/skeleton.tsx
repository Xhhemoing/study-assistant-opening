"use client";

import { useEffect, useState } from "react";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`relative overflow-hidden rounded-md bg-surface-2 ${className}`} aria-hidden="true"><div className="absolute inset-0 bg-gradient-to-r from-transparent via-surface/70 to-transparent motion-safe:animate-shimmer" /></div>;
}

/** Avoid flashing skeletons for short requests; unmounting cancels the delay. */
export function LoadingRows({ label = "正在读取你的学习内容", delayMs = 300 }: { label?: string; delayMs?: number }) {
  const [visible, setVisible] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) { setVisible(true); return; }
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  if (!visible) return null;
  const rows = [
    { title: "w-3/5", meta: "w-1/3" },
    { title: "w-4/5", meta: "w-2/5" },
    { title: "w-1/2", meta: "w-1/4" },
  ] as const;
  return <div className="space-y-4 p-4" role="status"><span className="sr-only">{label}</span>
    {rows.map((row, index) => <div key={index} className="flex items-center gap-3.5"><Skeleton className="size-9 shrink-0 rounded-lg" /><div className="min-w-0 flex-1 space-y-2"><Skeleton className={`h-3 rounded-sm ${row.title}`} /><Skeleton className={`h-2 rounded-sm ${row.meta}`} /></div></div>)}
  </div>;
}
