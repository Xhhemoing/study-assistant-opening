import type { TutorMode } from "@aistudy/contracts";

export type ModelTaskGroup = "tutor" | "materials" | "teaching" | "practice" | "settings";

export type ModelTaskSpec = {
  /** Settings-page label. */
  label: string;
  group: ModelTaskGroup;
  /** Budget ledger purpose recorded on every reservation for this task. */
  purpose: string;
  /** Tutor tasks keep the existing per-mode route in ai_settings. */
  tutorMode?: TutorMode;
  /** Input kinds the model must accept; routing fails explicitly otherwise. */
  needs?: readonly ModelInputKind[];
};

export type ModelInputKind = "vision" | "audio";

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
  "practice.grade-text": { label: "文字作答批改", group: "practice", purpose: "grade-text" },
  "practice.exam": { label: "真题考点与模拟练习", group: "practice", purpose: "course-exam" },
  "practice.grade-photo": { label: "拍照作答评阅", group: "practice", purpose: "grade-photo", needs: ["vision"] },
  "practice.recognize-photo": { label: "题目照片文字识别", group: "practice", purpose: "recognize-photo-question", needs: ["vision"] },
  "settings.probe": { label: "模型连通性测试", group: "settings", purpose: "probe" },
  "media.transcribe": { label: "音视频转写", group: "materials", purpose: "transcribe", needs: ["audio"] },
} as const satisfies Record<string, ModelTaskSpec>;

export type ModelTaskKey = keyof typeof MODEL_TASKS;

export function modelTaskSpec(task: ModelTaskKey): ModelTaskSpec {
  return MODEL_TASKS[task];
}

export function tutorModelTask(mode: TutorMode): ModelTaskKey {
  return `tutor.${mode}`;
}
