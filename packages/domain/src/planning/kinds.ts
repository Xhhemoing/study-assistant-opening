import type { ScenarioPreset, StatusWord } from "@aistudy/contracts";
import type { GoalKind } from "../goals/effective-requirements";
import { getScenarioPresetDefinition } from "./scenario-presets";

export type PlannerTier = Exclude<StatusWord, "stable">;

const OPTION_COPY: Record<GoalKind, { label: string; description: string }> = {
  "final-exam": { label: "期末优先", description: "先补薄弱和未测考点，再做变式保持手感。" },
  "entrance-exam": { label: "升学优先", description: "先巩固可用考点，再安排未测内容。" },
  interest: { label: "兴趣优先", description: "在预算内保留探索，并穿插未测内容。" },
  maintenance: { label: "保持优先", description: "只安排复习和已会内容的保持，不追新考点。" },
  custom: { label: "自定义安排", description: "按当前目标权重排列练习与复习。" },
};

export function scenarioToGoalKind(scenario: ScenarioPreset): GoalKind {
  if (scenario === "gaokao" || scenario === "kaoyan") return "entrance-exam";
  if (scenario === "final") return "final-exam";
  return "custom";
}

export function tierOrderForKind(kind: GoalKind): PlannerTier[] {
  if (kind === "maintenance") return ["weak", "usable"];
  if (kind === "entrance-exam") return getScenarioPresetDefinition("gaokao").tierOrder;
  if (kind === "final-exam") return getScenarioPresetDefinition("final").tierOrder;
  return getScenarioPresetDefinition("custom").tierOrder;
}

export function optionCopyForKind(kind: GoalKind): { id: string; label: string; description: string } {
  const copy = OPTION_COPY[kind];
  return { id: `option-${kind}`, label: copy.label, description: copy.description };
}
