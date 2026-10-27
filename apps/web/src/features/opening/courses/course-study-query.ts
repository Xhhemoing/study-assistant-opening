import { z } from "zod";

const practiceEntrySchema = z.object({
  mode: z.enum(["practice", "matrix"]),
  exercise: z.enum(["dimensions", "addition", "scalar", "multiplication"]).optional(),
  variant: z.coerce.number().int().min(0).max(8).optional(),
  skillLabel: z.string().trim().min(1).max(200).optional(),
  requirementKey: z.string().trim().min(1).max(200).optional(),
}).refine(value => (!value.requirementKey || Boolean(value.skillLabel)) && (!value.skillLabel || value.mode === "practice")).refine(value => value.mode === "matrix" || (value.exercise === undefined && value.variant === undefined));

const navigationSchema = z.object({
  activity: z.string().uuid().optional(),
  task: z.string().uuid().optional(),
  retest: z.string().uuid().optional(),
  after: z.string().uuid().optional(),
}).refine(value => !value.after || !(value.activity || value.task || value.retest));

type CourseStudyQuery = { skillLabel?: string; requirementKey?: string; mode?: string; exercise?: string; variant?: string;
  activity?: string; task?: string; retest?: string; after?: string };

/** The page's protocol dispatch must not drop a task before its admission checks run. */
export function courseStudyStandaloneActivity(query: CourseStudyQuery): string | undefined {
  if (query.task !== undefined || query.retest !== undefined || query.after !== undefined
    || parseCourseStudyPracticeEntry(query).practiceEntryError) return undefined;
  return query.activity;
}

export function parseCourseStudyPracticeEntry(query: CourseStudyQuery) {
  if (!navigationSchema.safeParse(query).success) return { practiceEntryError: "学习入口的活动或任务标识无效，请返回课程重新选择。原学习位置与草稿仍保留。" };
  if (query.mode === undefined && query.exercise === undefined && query.variant === undefined && query.skillLabel === undefined && query.requirementKey === undefined) return {};
  const parsed = practiceEntrySchema.safeParse(query);
  if (!parsed.success || query.activity || query.task || query.retest || query.after) return { practiceEntryError: "练习入口的类型、题型或变式无效，请返回课程重新选择。原学习位置与草稿仍保留。" };
  return { initialMode: parsed.data.mode, initialMatrixKey: parsed.data.exercise, initialMatrixVariant: parsed.data.variant, ...(parsed.data.skillLabel ? { initialFocus: { skillLabel: parsed.data.skillLabel, requirementKey: parsed.data.requirementKey ?? null } } : {}) };
}
