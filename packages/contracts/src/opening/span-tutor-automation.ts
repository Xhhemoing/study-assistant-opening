import { z } from "zod";
import { calendarDateSchema } from "./foundation";
export const spanTutorBudgetSchema = z.object({
  localDate: calendarDateSchema,
  timeZone: z.string().min(1).max(80).refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "Invalid time zone"),
  minutes: z.number().int().positive().max(240),
  grantRevision: z.number().int().positive(),
}).strict();
export const spanTutorAutomationSchema = spanTutorBudgetSchema.extend({ createdTaskVersion: z.number().int().positive() }).strict();
export type SpanTutorBudget = z.infer<typeof spanTutorBudgetSchema>;
export type SpanTutorAutomation = z.infer<typeof spanTutorAutomationSchema>;
