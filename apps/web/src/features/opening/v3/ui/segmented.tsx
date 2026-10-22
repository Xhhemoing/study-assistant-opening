"use client";
import { ui } from "@aistudy/ui";

/** 单选分段（主题、阅读字体、缩放模式）：原生 radio，键盘与读屏天然正确。 */
export function Segmented<T extends string>({ name, value, options, onChange, label }: { name: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={ui.segment}>
      {options.map(option => (
        <label key={option.value} className={`${ui.segmentItem} inline-flex cursor-pointer items-center justify-center whitespace-nowrap has-[:checked]:bg-surface has-[:checked]:font-medium has-[:checked]:text-text has-[:checked]:shadow-card has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus-ring`}>
          <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} className="sr-only" />
          {option.label}
        </label>
      ))}
    </div>
  );
}
