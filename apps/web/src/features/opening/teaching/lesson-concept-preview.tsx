"use client";

import { useEffect, useRef } from "react";

/** A view of already visible lesson text, never a newly generated explanation. */
export function LessonConceptPreview({ text, label, onClose, onContinue }: {
  text: string;
  label: string;
  onClose: () => void;
  onContinue?: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.focus({ preventScroll: true }); }, []);
  return <div ref={panel} role="dialog" aria-label="课堂片段预览" tabIndex={-1}
    className="fixed bottom-4 left-4 right-4 z-40 max-h-[70vh] overflow-y-auto rounded-card border border-line bg-popover p-4 text-text shadow-lg sm:left-auto sm:w-96"
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <h3 className="text-sm font-semibold">当前课堂片段</h3>
    <p className="mt-1 text-xs text-text-2">来源：{label} · 当前已显示的教学内容</p>
    <blockquote className="mt-3 whitespace-pre-wrap break-words rounded-ctl bg-surface-2 p-3 text-sm leading-7">{text}</blockquote>
    <p className="mt-2 text-xs text-text-2">仅展示所选文字，未扩展范围。可带此片段继续提问。</p>
    <div className="mt-3 flex justify-end gap-2">
      <button type="button" className="min-h-10 rounded-pill px-3 text-sm hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring" onClick={onClose}>返回课堂</button>
      {onContinue ? <button type="button" className="min-h-10 rounded-pill bg-ink px-3 text-sm text-on-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring" onClick={onContinue}>继续问</button> : null}
    </div>
  </div>;
}
