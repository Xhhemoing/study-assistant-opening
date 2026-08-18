import { z } from "zod";

export const plannedTaskKindSchema = z.enum(["practice", "review", "explore", "output"]);

export const plannedTaskSchema = z.object({
  id: z.string().min(1),
  kind: plannedTaskKindSchema,
  refId: z.string().min(1),
  title: z.string().min(1),
  estimatedMinutes: z.number().int().positive(),
  reason: z.string().min(1),
  locked: z.boolean(),
  status: z.enum(["pending", "done", "skipped"]),
});

export const planOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  tasks: z.array(plannedTaskSchema),
});

export const todayPlanSchema = z.object({
  id: z.string().min(1),
  ownerUserId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  budgetMinutes: z.number().int().positive(),
  totalMinutes: z.number().int().nonnegative(),
  tasks: z.array(plannedTaskSchema),
  options: z.array(planOptionSchema),
  strategyVersion: z.string().min(1),
  generatedAt: z.string().datetime(),
  evidenceSnapshotId: z.string().min(1),
});

export type PlannedTaskKind = z.infer<typeof plannedTaskKindSchema>;
export type PlannedTask = z.infer<typeof plannedTaskSchema>;
export type PlanOption = z.infer<typeof planOptionSchema>;
export type TodayPlan = z.infer<typeof todayPlanSchema>;
