import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { plannedBlockSchema } from "./planning";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const instant = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const minutes = z.number().finite().nonnegative().max(1440);

/** Read-only capacity estimate for existing tasks, never an accepted syllabus or mastery claim. */
export const sprintBudgetResponseSchema = z.object({
  courseId: uuidSchema,
  generatedAt: isoDateTimeSchema,
  status: z.enum(["ready", "needs_goal", "needs_settings", "invalid_settings", "deadline_reached"]),
  examDate: date.nullable(),
  timeZone: z.string().min(1).max(80).nullable(),
  dailyMinutes: minutes.nullable(),
  horizonTruncated: z.boolean(),
  tasks: z.array(z.object({ id: uuidSchema, title: z.string().min(1).max(240) }).strict()).max(2000),
  days: z.array(z.object({
    date, budgetMinutes: minutes, committedMinutes: z.number().finite().nonnegative(), plannedMinutes: minutes,
    blocks: z.array(plannedBlockSchema).max(2000),
  }).strict()).max(28),
  unscheduled: z.array(z.object({ taskId: uuidSchema, reason: z.string().min(1).max(100) }).strict()).max(2000),
  deferredTaskIds: z.array(uuidSchema).max(2000),
  scheduledTaskIds: z.array(uuidSchema).max(2000),
  warnings: z.array(z.string().min(1).max(500)).max(100),
}).strict();
export type SprintBudgetResponse = z.infer<typeof sprintBudgetResponseSchema>;
