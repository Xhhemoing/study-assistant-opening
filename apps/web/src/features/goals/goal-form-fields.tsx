"use client";

import type { ChangeEvent } from "react";
import type { ScenarioPreset } from "@aistudy/contracts";
import { SEED_SYLLABUS } from "../../lib/data/mock/seeds";
import { GOAL_SCENARIOS } from "./goal-model";

export function ScenarioPicker({
  value,
  onChange,
}: {
  value: ScenarioPreset;
  onChange: (value: ScenarioPreset) => void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold text-text">选择目标场景</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {GOAL_SCENARIOS.map((scenario) => (
          <label className={`cursor-pointer rounded-lg border p-4 transition-colors focus-within:ring-2 focus-within:ring-primary ${value === scenario.value ? "border-primary bg-primary/10" : "border-line bg-surface hover:bg-surface-2"}`} key={scenario.value}>
            <input
              checked={value === scenario.value}
              className="sr-only"
              name="goal-scenario"
              onChange={() => onChange(scenario.value)}
              type="radio"
              value={scenario.value}
            />
            <span className="block text-sm font-semibold text-text">{scenario.label}</span>
            <span className="mt-1 block text-xs leading-5 text-text-dim">{scenario.description}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ExamDateField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onChange(event.target.value || null);
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="text-sm font-semibold text-text" htmlFor="goal-exam-date">目标日期</label>
        <p className="mt-1 text-xs text-text-dim">可跳过，之后仍能在详情页补充。</p>
      </div>
      <input className="min-h-11 rounded-lg border border-line bg-surface px-3 text-sm text-text outline-none focus:border-primary focus:ring-2 focus:ring-primary/30" id="goal-exam-date" onChange={handleChange} type="date" value={value ?? ""} />
    </div>
  );
}

export function SubjectPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  function toggleSubject(subject: string) {
    onChange(value.includes(subject) ? value.filter((item) => item !== subject) : [...value, subject]);
  }

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold text-text">选择学习主题</legend>
      <p className="text-xs text-text-dim">可多选，也可以暂时跳过。</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {SEED_SYLLABUS.map((point) => (
          <label className="flex min-h-11 items-center gap-3 rounded-lg border border-line bg-surface px-3 text-sm text-text hover:bg-surface-2" key={point.id}>
            <input checked={value.includes(point.title)} className="size-4 accent-primary" onChange={() => toggleSubject(point.title)} type="checkbox" />
            <span>{point.title}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function DailyMinutesField({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-semibold text-text" htmlFor="goal-daily-minutes">每天投入时间</label>
        <p className="mt-1 text-xs text-text-dim">15–120 分钟，之后可以调整。</p>
      </div>
      <div className="flex items-center gap-3">
        <input aria-label="每天投入时间" className="min-h-11 w-28 rounded-lg border border-line bg-surface px-3 text-sm text-text outline-none focus:border-primary focus:ring-2 focus:ring-primary/30" id="goal-daily-minutes" max={120} min={15} onChange={(event) => onChange(Number(event.target.value) || 15)} step={5} type="number" value={value} />
        <span className="text-sm text-text-dim">分钟 / 天</span>
      </div>
      <input aria-label="每天投入时间滑块" className="w-full accent-primary" max={120} min={15} onChange={(event) => onChange(Number(event.target.value))} step={5} type="range" value={value} />
    </div>
  );
}
