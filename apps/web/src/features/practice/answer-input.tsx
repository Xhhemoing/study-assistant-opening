"use client";

import type { PracticeItem } from "@aistudy/contracts";

interface AnswerInputProps {
  item: PracticeItem;
  answer: string;
  disabled: boolean;
  onChange: (answer: string) => void;
  onSubmit: () => void;
}

const controlClassName = "size-4 border-line bg-surface text-primary focus:ring-2 focus:ring-primary/30";
const labelClassName = "flex cursor-pointer items-start gap-3 rounded-lg border border-line px-3 py-3 text-sm text-text transition-colors hover:bg-surface-2 has-[:checked]:border-primary has-[:checked]:bg-primary/10";

export function AnswerInput({ item, answer, disabled, onChange, onSubmit }: AnswerInputProps) {
  if (item.kind === "short_answer") {
    return (
      <label className="grid gap-2" htmlFor="practice-answer">
        <span className="text-sm font-semibold text-text">你的答案</span>
        <input
          autoComplete="off"
          className="min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-text outline-none placeholder:text-text-dim focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={disabled}
          id="practice-answer"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
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
      if (event.key === "Enter") {
        event.preventDefault();
        onSubmit();
      }
    }}>
      <legend className="text-sm font-semibold text-text">{checkpoint ? "选择所有正确步骤" : "选择一个答案"}</legend>
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
              <span className="leading-6">{option}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
