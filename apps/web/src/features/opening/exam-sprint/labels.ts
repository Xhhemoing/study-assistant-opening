import type { ExamAttemptView, ExamErrorCause, ExamMode, ExamSourceRecord } from "@aistudy/contracts";

export const modeLabels: Record<ExamMode, string> = { diagnostic: "摸底诊断", practice: "针对练习", retest: "无提示复测", "mock-a": "短模拟 A", "mock-b": "短模拟 B" };
export const causeLabels: Record<ExamErrorCause, string> = { concept: "概念不清", method: "选法不当", calculation: "运算失误", conditions: "遗漏条件", modeling: "建模困难", reading: "英文审题", time: "时间不足" };
export const phaseLabels: Record<ExamSourceRecord["phase"], string> = { first: "首次尝试", blind: "盲重做", delayed: "隔日复测", variant: "陌生变式" };
export const outcomeLabels: Record<ExamSourceRecord["outcome"], string> = { correct: "完整正确（自评）", partial: "部分正确（自评）", incorrect: "未做对（自评）", read: "只阅读 / 看懂解析" };
export const assistanceLabels: Record<ExamSourceRecord["assistance"], string> = { none: "独立完成", hint: "使用提示 / 外部帮助", solution: "看过答案" };
export function formatDuration(seconds: number): string { const total = Math.max(0, Math.floor(seconds)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`; }
export function practiceModeForDueAt(dueAt: string | null, now = Date.now()): "practice" | "retest" { return dueAt !== null && Date.parse(dueAt) <= now ? "retest" : "practice"; }
export function hasSprintAttemptHelp(attempt: Pick<ExamAttemptView, "help" | "lessonExposureIds" | "partialExampleExposureIds">): boolean { return attempt.help.length > 0 || (attempt.lessonExposureIds?.length ?? 0) > 0 || (attempt.partialExampleExposureIds?.length ?? 0) > 0; }
/** Learner-facing export: always a file download, never a raw JSON page. */
export const EXAM_SPRINT_EXPORT = { href: "/api/opening/exam-sprint/export", filename: "exam-sprint-records.json" } as const;
