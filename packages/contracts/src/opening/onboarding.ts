import { z } from "zod";
import { uuidSchema } from "./foundation";
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "invalid calendar date");
export const openingOnboardingInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("skip"), clientKey: z.string().min(8).max(160) }).strict(),
  z.object({ action: z.literal("complete"), clientKey: z.string().min(8).max(160),
    subject: z.string().trim().min(1).max(160), scenario: z.enum(["final", "gaokao", "kaoyan", "custom"]),
    examDate: calendarDate.nullable(), timeZone: z.string().min(1).max(80),
    sourceIds: z.array(uuidSchema).max(32).refine(ids => ids.length === new Set(ids).size, "duplicate source IDs"),
  }).strict(),
]);
export type OpeningOnboardingInput = z.infer<typeof openingOnboardingInputSchema>;
export const openingOnboardingResultSchema = z.object({
  completed: z.boolean(), courseId: uuidSchema.nullable(), taskIds: z.array(uuidSchema).max(3),
  needsOnboarding: z.boolean(),
}).strict();
export type OpeningOnboardingResult = z.infer<typeof openingOnboardingResultSchema>;
