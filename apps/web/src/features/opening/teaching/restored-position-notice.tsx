"use client";
import { useEffect, useState } from "react";

export function RestoredPositionNotice({ restored }: { restored: boolean }) {
  const [visible, setVisible] = useState(restored);
  useEffect(() => {
    setVisible(restored);
    if (!restored) return;
    const timer = window.setTimeout(() => setVisible(false), 3000);
    return () => window.clearTimeout(timer);
  }, [restored]);
  return visible ? <p role="status" className="shrink-0 px-4 py-2 text-xs text-text-3 sm:px-8">已恢复学习位置</p> : null;
}
