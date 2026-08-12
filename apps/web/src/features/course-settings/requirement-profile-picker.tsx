"use client";

import { Eye, EyeOff } from "lucide-react";
import type { AbilityWeights } from "@aistudy/contracts";
import { REQUIREMENT_PROFILES_BY_KIND } from "@aistudy/domain";
import {
  ABILITY_DIMENSION_LABELS,
  REQUIREMENT_PROFILE_OPTIONS,
  type RequirementProfileDraft,
} from "./requirement-profile-model";

export function RequirementProfilePicker({
  value,
  onChange,
}: {
  value: RequirementProfileDraft;
  onChange: (value: RequirementProfileDraft) => void;
}) {
  const preset = REQUIREMENT_PROFILES_BY_KIND[value.kind];

  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-text">课程学习方式</legend>
        <p className="text-xs text-text-dim">
          选择最接近这门课程的类型，系统据此安排练习与证据收集。
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {REQUIREMENT_PROFILE_OPTIONS.map((option) => (
            <label
              className={`cursor-pointer rounded-lg border p-4 transition-colors focus-within:ring-2 focus-within:ring-primary ${
                value.kind === option.value
                  ? "border-primary bg-primary/10"
                  : "border-line bg-surface hover:bg-surface-2"
              }`}
              key={option.value}
            >
              <input
                checked={value.kind === option.value}
                className="sr-only"
                name="course-requirement-profile"
                onChange={() => onChange({ ...value, kind: option.value })}
                type="radio"
                value={option.value}
              />
              <span className="block text-sm font-semibold text-text">{option.label}</span>
              <span className="mt-1 block text-xs leading-5 text-text-dim">
                {option.description}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface p-4">
        <input
          checked={value.assessmentMode === "disabled"}
          className="mt-0.5 size-4 accent-primary"
          onChange={(event) =>
            onChange({
              ...value,
              assessmentMode: event.target.checked ? "disabled" : "basic",
            })
          }
          type="checkbox"
        />
        <span className="space-y-1">
          <span className="flex items-center gap-2 text-sm font-semibold text-text">
            {value.assessmentMode === "disabled" ? (
              <EyeOff aria-hidden="true" size={16} />
            ) : (
              <Eye aria-hidden="true" size={16} />
            )}
            禁用评估
          </span>
          <span className="block text-xs leading-5 text-text-dim">
            适合只想自由记录、暂不需要能力诊断或考试的课程。
          </span>
        </span>
      </label>

      <details className="rounded-lg border border-line bg-surface p-4">
        <summary className="cursor-pointer text-sm font-semibold text-text">
          开发者设置：{preset.label} 的能力权重
        </summary>
        <div className="mt-4 grid gap-2">
          {weightRows(preset.abilities)}
          <p className="text-xs text-text-dim">
            完整权重调整将在开发者设置中开放；当前展示的是该预设的默认组合。
          </p>
        </div>
      </details>
    </div>
  );
}

function weightRows(abilities: AbilityWeights) {
  return (Object.keys(ABILITY_DIMENSION_LABELS) as Array<keyof typeof ABILITY_DIMENSION_LABELS>).map(
    (key) => {
      const filled = Math.round(abilities[key] / 10);
      return (
        <div className="flex items-center justify-between gap-4" key={key}>
          <span className="text-sm text-text-dim">{ABILITY_DIMENSION_LABELS[key]}</span>
          <div className="flex items-center gap-2">
            <div className="flex gap-0.5" aria-hidden="true">
              {Array.from({ length: 10 }, (_, index) => (
                <span
                  className={`h-2 w-3 rounded-sm ${index < filled ? "bg-primary" : "bg-surface-2"}`}
                  key={index}
                />
              ))}
            </div>
            <span className="w-8 text-right text-xs tabular-nums text-text">
              {abilities[key]}%
            </span>
          </div>
        </div>
      );
    },
  );
}
