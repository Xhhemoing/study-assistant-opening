import { z } from "zod";

const practiceEntrySchema = z.object({
  mode: z.enum(["practice", "matrix"]),
  exercise: z.enum(["dimensions", "addition", "scalar", "multiplication"]).optional(),
  variant: z.coerce.number().int().min(0).max(8).optional(),
}).refine(value => value.mode === "matrix" || (value.exercise === undefined && value.variant === undefined));

export function parseCourseStudyPracticeEntry(query: { mode?: string; exercise?: string; variant?: string; activity?: string; task?: string; retest?: string; after?: string }) {
  if (query.mode === undefined && query.exercise === undefined && query.variant === undefined) return {};
  const parsed = practiceEntrySchema.safeParse(query);
  if (!parsed.success || query.activity || query.task || query.retest || query.after) return { practiceEntryError: "练习入口的类型、题型或变式无效，请返回课程重新选择。原学习位置与草稿仍保留。" };
  return { initialMode: parsed.data.mode, initialMatrixKey: parsed.data.exercise, initialMatrixVariant: parsed.data.variant };
}
