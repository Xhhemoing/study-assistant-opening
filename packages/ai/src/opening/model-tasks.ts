import type { TutorMode } from "@aistudy/contracts";

export type ModelTaskGroup = "tutor" | "materials" | "teaching";

export type ModelTaskSpec = {
  /** Settings-page label. */
  label: string;
  group: ModelTaskGroup;
  /** Budget ledger purpose recorded on every reservation for this task. */
  purpose: string;
  /** Tutor tasks keep the existing per-mode route in ai_settings. */
  tutorMode?: TutorMode;
};

/**
 * Every model use in Opening. A new AI feature adds one entry here and calls the
 * gateway with its key; routing, provider construction and the ledger stay in one place.
 */
export const MODEL_TASKS = {
  "tutor.listen": { label: "辅导 · 倾听", group: "tutor", purpose: "tutor", tutorMode: "listen" },
  "tutor.hint": { label: "辅导 · 提示", group: "tutor", purpose: "tutor", tutorMode: "hint" },
  "tutor.explain": { label: "辅导 · 解释", group: "tutor", purpose: "tutor", tutorMode: "explain" },
  "tutor.think_together": { label: "辅导 · 共同思考", group: "tutor", purpose: "tutor", tutorMode: "think_together" },
  "knowledge.extract": { label: "课程知识图谱抽取", group: "materials", purpose: "build-course-knowledge" },
  "teaching.compile": { label: "AI 主讲内容编译", group: "teaching", purpose: "compile-teaching-unit" },
} as const satisfies Record<string, ModelTaskSpec>;

export type ModelTaskKey = keyof typeof MODEL_TASKS;

export function modelTaskSpec(task: ModelTaskKey): ModelTaskSpec {
  return MODEL_TASKS[task];
}

export function tutorModelTask(mode: TutorMode): ModelTaskKey {
  return `tutor.${mode}`;
}
