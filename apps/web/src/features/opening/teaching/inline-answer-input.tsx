"use client";
import { useId } from "react";
import type { TeachingQuestionInteraction } from "@aistudy/contracts";
import { LearningProse } from "../assistant/learning-prose";
import { MathInput } from "./math-input";
import { ui } from "../design/ui";

export function InlineAnswerInput({ interaction, value, disabled, onChange }: {
  interaction?: TeachingQuestionInteraction; value: string; disabled: boolean; onChange: (value: string) => void;
}) {
  const name = useId();
  if (interaction?.kind === "choice") return <fieldset className="space-y-2" disabled={disabled}>
    <legend className="mb-2 text-sm font-medium">先选一个，再看看为什么</legend>
    {interaction.options.map(option => {
      const answer = `${option.id}. ${option.label}`;
      return <label key={option.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line p-3 text-sm has-[:checked]:bg-accent-soft">
        <input type="radio" name={name} className="mt-1 accent-accent" value={answer} checked={value === answer} onChange={() => onChange(answer)} />
        <div>{option.id}. <LearningProse text={option.label} /></div>
      </label>;
    })}
  </fieldset>;
  if (interaction?.kind === "numeric") return <label className="block space-y-1 text-sm">我的答案{interaction.unit ? `（${interaction.unit}）` : ""}
    <input className={ui.input} type="text" inputMode="decimal" value={value} maxLength={160} disabled={disabled} placeholder="数字或分数，如 1/2" onChange={event => onChange(event.target.value)} />
  </label>;
  return <MathInput label="我的想法" value={value} maxLength={20_000} disabled={disabled} onChange={onChange} />;
}
