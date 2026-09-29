"use client";

import type { PracticeItem } from "@aistudy/contracts";

interface AnswerInputProps {
  item: PracticeItem;
  answer: string;
  disabled: boolean;
  onChange: (answer: string) => void;
  onSubmit: () => void;
}

const controlClassName = "size-4 border-zinc-200 bg-white text-emerald-700 accent-emerald-700 focus:ring-2 focus:ring-zinc-200";
const labelClassName = "flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 px-3 py-3 text-sm text-zinc-900 transition-colors duration-150 motion-reduce:transition-none hover:bg-zinc-100 has-[:checked]:border-emerald-600 has-[:checked]:bg-emerald-50";

export function AnswerInput({ item, answer, disabled, onChange, onSubmit }: AnswerInputProps) {
  if (item.kind === "short_answer") {
    return (
      <label className="grid gap-2" htmlFor="practice-answer">
        <span className="text-sm font-semibold text-zinc-900">你的答案</span>
        <input
          autoComplete="off"
          className="min-h-10 md:min-h-8 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none placeholder:text-zinc-500 focus:border-emerald-600 focus:ring-2 focus:ring-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={disabled}
          id="practice-answer"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSubmit();
            }
          }}
          onChange={(event) => onChange(event.target.value)}
          placeholder="写下你的答案"
          value={answer}
        />
      </label>
    );
  }

  const options = item.options ?? [];
  const checkpoint = item.kind === "checkpoint";
  const selected = new Set(answer.split(",").filter(Boolean));

  function toggleCheckpoint(value: string) {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange([...next].sort((a, b) => Number(a) - Number(b)).join(","));
  }

  return (
    <fieldset className="grid gap-3" disabled={disabled} onKeyDown={(event) => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        onSubmit();
      }
    }}>
      <legend className="text-sm font-semibold text-zinc-900">{checkpoint ? "选择所有正确步骤" : "选择一个答案"}</legend>
      <div className="grid gap-2">
        {options.map((option, index) => {
          const value = checkpoint ? String(index) : String.fromCharCode(65 + index);
          return (
            <label className={labelClassName} key={value}>
              <input
                checked={checkpoint ? selected.has(value) : answer === value}
                className={controlClassName}
                name={checkpoint ? `practice-checkpoint-${item.id}` : `practice-choice-${item.id}`}
                onChange={() => checkpoint ? toggleCheckpoint(value) : onChange(value)}
                type={checkpoint ? "checkbox" : "radio"}
                value={value}
              />
              <span className="leading-7">{option}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
