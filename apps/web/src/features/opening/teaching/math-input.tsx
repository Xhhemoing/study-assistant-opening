"use client";

import { useId, useRef } from "react";
import { LearningProse } from "../assistant/learning-prose";

const symbols = [["α", "$\\alpha$"], ["β", "$\\beta$"], ["分数", "$\\frac{}{}$"], ["平方", "$x^2$"], ["等式", "$$\n\n$$"]] as const;

export function insertMathSymbol(value: string, symbol: string, start: number, end: number, maxLength: number): { value: string; cursor: number } {
  const next = value.slice(0, start) + symbol + value.slice(end);
  return next.length > maxLength ? { value, cursor: start } : { value: next, cursor: start + symbol.length };
}

/** Edits the existing answer string; preview does not assess or submit it. */
export function MathInput({ label, value, onChange, disabled = false, maxLength = 20_000 }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean; maxLength?: number }) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const trimmed = value.trim();
  const englishWords = trimmed ? (trimmed.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)*/g)?.length ?? 0) : 0;
  return <div className="space-y-2.5">
    <div className="flex items-center justify-between gap-2">
      <label htmlFor={id} className="block text-sm font-medium text-text">{label}</label>
      {trimmed ? <span className="text-xs tabular-nums text-text-3">{englishWords >= 10 ? `${englishWords} 词 · ${trimmed.length} 字` : `${trimmed.length} 字`}</span> : null}
    </div>
    <textarea ref={input} id={id} aria-describedby={`${id}-help`} className="min-h-36 w-full rounded-xl border border-line bg-surface px-4 py-3 text-base leading-7 text-text shadow-card transition-[border-color,box-shadow] duration-150 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus-ring disabled:opacity-60" value={value} maxLength={maxLength} disabled={disabled} onChange={event => onChange(event.target.value)} />
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="插入数学符号">
      {symbols.map(([label, symbol]) => <button key={label} type="button" disabled={disabled} className="keycap min-h-8 min-w-8 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-text-2 transition-[background-color,color,transform] duration-150 hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:scale-[0.98] disabled:opacity-60" onClick={() => {
        const element = input.current;
        const inserted = insertMathSymbol(value, symbol, element?.selectionStart ?? value.length, element?.selectionEnd ?? value.length, maxLength);
        onChange(inserted.value);
        requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(inserted.cursor, inserted.cursor); });
      }}>{label}</button>)}
    </div>
    <p id={`${id}-help`} className="text-xs leading-5 text-text-3">可写中英文长文或 LaTeX；用 $ 包住公式。预览不会判分。</p>
    {trimmed ? <details className="text-xs text-text-2"><summary className="min-h-6 cursor-pointer font-medium">查看答案排版预览</summary><div className="mt-2 rounded-xl border border-line bg-surface-2/60 p-3.5 text-base leading-7 text-text"><LearningProse text={value} /></div></details> : null}
  </div>;
}
