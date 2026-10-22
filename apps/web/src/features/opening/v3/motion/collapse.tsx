"use client";
import type { ReactNode } from "react";

/**
 * 高度展开/收起（accordion）：grid-template-rows 0fr↔1fr，不测量高度；展开 320ms、收起 150ms。收起时保留挂载（inert），
 * 内部输入与滚动不丢。用于补充解释、提示、恢复提示、冲刺调整等。
 */
export function Collapse({ open, children, className = "" }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <div data-open={open} inert={!open} aria-hidden={!open || undefined}
      className={`grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-(--duration-exit) ease-out-expo data-[open=true]:grid-rows-[1fr] data-[open=true]:duration-(--duration-panel) data-[open=true]:opacity-100 motion-reduce:transition-none ${className}`}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
