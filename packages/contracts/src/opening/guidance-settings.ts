import { z } from "zod";
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const openingGuidanceSettingsSchema = z.object({
  mode: z.enum(["free", "advisory", "coach"]),
  protectedSlots: z.array(z.object({ start: clock, end: clock }).strict().refine(s => s.start < s.end, "end must follow start")).max(12),
  dailyMinutes: z.number().int().min(10).max(480),
}).strict();
export type OpeningGuidanceSettings = z.infer<typeof openingGuidanceSettingsSchema>;
export const DEFAULT_OPENING_GUIDANCE_SETTINGS: OpeningGuidanceSettings = { mode: "advisory", protectedSlots: [], dailyMinutes: 60 };
