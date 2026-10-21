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
  return <div className="space-y-4 p-4" role="status"><span className="sr-only">{label}</span>
    {[0, 1, 2].map(row => <div key={row} className="flex items-center gap-3"><Skeleton className="size-8" /><div className="flex-1 space-y-2"><Skeleton className="h-2.5 w-2/3" /><Skeleton className="h-2 w-1/3" /></div></div>)}
  </div>;
}
