"use client";

import type { ReviewGrade } from "@aistudy/contracts";
import { Eye, RotateCcw } from "lucide-react";
import { useId } from "react";
import { cardKeyboardBlocked, resolveCardShortcut } from "./card-shortcuts";

export function CardStack({ front, back, flipped, disabled, remaining, onFlip, onGrade }: { front: string; back: string; flipped: boolean; disabled: boolean; remaining: number; onFlip: () => void; onGrade: (grade: ReviewGrade) => void }) {
  const helpId = useId();
  return <div className="space-y-3">
    <div className="relative pb-2">
      {remaining > 1 ? <div aria-hidden="true" className="pointer-events-none absolute inset-x-2 bottom-0 top-3 rounded-xl border border-line bg-surface-2" /> : null}
      <button type="button" disabled={disabled} aria-label={flipped ? "显示卡片正面" : "显示卡片背面"} aria-pressed={flipped} aria-keyshortcuts={flipped ? "Space 1 2 3 4" : "Space"} aria-describedby={helpId} className="relative grid min-h-[18rem] w-full gap-4 rounded-xl border border-text-3 bg-surface p-6 text-left shadow-xs transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait motion-reduce:transition-none"
        onClick={event => { if (!disabled && !cardKeyboardBlocked(event.currentTarget, event.target)) onFlip(); }}
        onKeyDown={event => {
          const native = event.nativeEvent;
          if (event.key === " " || ((native.isComposing || native.keyCode === 229) && event.key === "Enter")) event.preventDefault();
          const action = resolveCardShortcut(native, { flipped, disabled, blocked: cardKeyboardBlocked(event.currentTarget, event.target) });
          if (!action) return;
          event.preventDefault();
          if (action.kind === "flip") onFlip(); else onGrade(action.grade);
        }}>
        <span className="text-xs font-semibold text-accent">{flipped ? "背面" : "正面"}</span>
        <span className="self-center whitespace-pre-wrap text-sm font-medium leading-7 text-text">{flipped ? back : front}</span>
        <span className="inline-flex items-center gap-2 text-xs text-text-2">{flipped ? <RotateCcw size={15} aria-hidden /> : <Eye size={15} aria-hidden />}{flipped ? "查看正面" : "显示背面"}</span>
      </button>
    </div>
    <p id={helpId} className="text-xs leading-6 text-text-3">聚焦卡片后：空格翻面；揭示后按 1 忘记、2 困难、3 良好、4 简单。</p>
  </div>;
}
