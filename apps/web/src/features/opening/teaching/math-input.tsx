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
  return <div className="space-y-2">
    <label htmlFor={id} className="block text-sm font-medium text-text">{label}</label>
    <textarea ref={input} id={id} aria-describedby={`${id}-help`} className="min-h-28 w-full rounded-md border border-text-3 bg-surface px-3 py-2 text-base leading-7 text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60" value={value} maxLength={maxLength} disabled={disabled} onChange={event => onChange(event.target.value)} />
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="插入数学符号">
      {symbols.map(([label, symbol]) => <button key={label} type="button" disabled={disabled} className="min-h-8 min-w-8 rounded-md border border-line px-2 text-xs text-text-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60" onClick={() => {
        const element = input.current;
        const inserted = insertMathSymbol(value, symbol, element?.selectionStart ?? value.length, element?.selectionEnd ?? value.length, maxLength);
        onChange(inserted.value);
        requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(inserted.cursor, inserted.cursor); });
      }}>{label}</button>)}
    </div>
    <p id={`${id}-help`} className="text-xs leading-5 text-text-2">可写文字或 LaTeX；用 $ 包住公式。预览不会判分。</p>
    {value.trim() ? <details className="text-xs text-text-2"><summary className="min-h-6 cursor-pointer">查看答案排版预览</summary><div className="mt-2 rounded-md bg-surface-2 p-3 text-base leading-7 text-text"><LearningProse text={value} /></div></details> : null}
  </div>;
}
