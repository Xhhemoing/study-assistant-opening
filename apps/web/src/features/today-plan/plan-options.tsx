"use client";

import { ListChecks } from "lucide-react";
import type { TodayPlan } from "@aistudy/contracts";

export function PlanOptionsPicker({
  plan,
  selectedId,
  onSelect,
  onConfirm,
  confirming,
}: {
  plan: TodayPlan;
  selectedId: string;
  onSelect: (optionId: string) => void;
  onConfirm: () => void;
  confirming: boolean;
}) {
  return (
    <section className="space-y-4" aria-labelledby="plan-options-heading">
      <div className="flex items-center gap-2">
        <ListChecks aria-hidden="true" className="text-primary" size={19} />
        <h2 className="text-base font-semibold text-text" id="plan-options-heading">
          选择今天的安排
        </h2>
      </div>
      <p className="text-sm leading-6 text-text-dim">
        多个目标产生了不同的优先级。先选一个方案，系统不会自动替你决定。
      </p>
      <fieldset className="space-y-3">
        <legend className="sr-only">计划方案</legend>
        {plan.options.map((option) => {
          const checked = option.id === selectedId;
          return (
            <label
              className={`block cursor-pointer rounded-lg border p-4 focus-within:ring-2 focus-within:ring-primary ${checked ? "border-primary bg-primary/10" : "border-line bg-surface hover:bg-surface-2"}`}
              key={option.id}
            >
              <input
                checked={checked}
                className="sr-only"
                name="plan-option"
                onChange={() => onSelect(option.id)}
                type="radio"
                value={option.id}
              />
              <span className="block text-sm font-semibold text-text">{option.label}</span>
              <span className="mt-1 block text-xs leading-5 text-text-dim">{option.description}</span>
              <span className="mt-2 block text-xs text-text-dim">
                {option.tasks.length} 项 · 约 {option.tasks.reduce((sum, task) => sum + task.estimatedMinutes, 0)} 分钟
              </span>
            </label>
          );
        })}
      </fieldset>
      <button
        className="inline-flex min-h-10 items-center rounded-md bg-primary px-3 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
        disabled={confirming || !selectedId}
        onClick={onConfirm}
        type="button"
      >
        使用这个安排
      </button>
    </section>
  );
}
