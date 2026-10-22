"use client";
import { useEffect, useState } from "react";
import { interactionMotionReduced } from "../../design/haptics";

/** 退场动画：open 变 false 后保留 exitMs 再卸载；state 用于 data-[state=closed]:animate-* */
export function usePresence(open: boolean, exitMs = 160) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    if (interactionMotionReduced()) { setMounted(false); return; }
    const timer = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(timer);
  }, [open, exitMs]);
  return { mounted, state: open ? "open" as const : "closed" as const };
}
