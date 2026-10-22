"use client";
import { useRef } from "react";
import { ui } from "@aistudy/ui";
import { runIndicatorTransition } from "../motion/view-transition";

/** 单选分段（主题、目标、阅读字体）：原生 radio；选中底块在选项间滑动（tabs sliding）。 */
export function Segmented<T extends string>({ name, value, options, onChange, label }: { name: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  const group = useRef<HTMLDivElement>(null);
  return (
    <div ref={group} role="radiogroup" aria-label={label} className={ui.segment}>
      {options.map(option => {
        const checked = value === option.value;
        return (
          <label key={option.value} className={`${ui.segmentItem} relative inline-flex cursor-pointer items-center justify-center whitespace-nowrap has-[:checked]:font-medium has-[:checked]:text-text has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus-ring`}>
            <input type="radio" name={name} value={option.value} checked={checked} onChange={() => runIndicatorTransition(group.current, () => onChange(option.value))} className="sr-only" />
            {checked && <span data-pill aria-hidden="true" className="absolute inset-0 rounded-sm bg-surface shadow-card" />}
            <span className="relative">{option.label}</span>
          </label>
        );
      })}
    </div>
  );
}
