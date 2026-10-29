import { z } from "zod";
import { uuidSchema } from "./foundation";
import { studyIntentEventSchema } from "./study-session-intent";

/** Actual model inputs, not a claim that the mode was manually selected. */
export const helpInputSnapshotSchema = z.object({
  userTurnId: uuidSchema,
  assistantTurnId: uuidSchema,
  tutorMode: z.enum(["hint", "explain", "listen", "think_together"]),
  studyIntent: studyIntentEventSchema.pick({ intent: true, action: true }).nullable(),
}).strict();
export type HelpInputSnapshot = z.infer<typeof helpInputSnapshotSchema>;
