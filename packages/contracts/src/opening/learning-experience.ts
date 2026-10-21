import { z } from "zod";
import { uuidSchema } from "./foundation";
export const learningExperienceInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("first_text"), jobId: uuidSchema, clientKey: z.string().min(1).max(200),
    durationMs: z.number().int().min(1).max(600_000) }).strict(),
  z.object({ kind: z.literal("next_step_shown"), targetType: z.enum(["activity", "course", "conversation"]), targetId: uuidSchema }).strict(),
  z.object({ kind: z.literal("next_step_started"), targetType: z.enum(["activity", "course", "conversation"]), targetId: uuidSchema }).strict(),
]);
export type LearningExperienceInput = z.infer<typeof learningExperienceInputSchema>;
