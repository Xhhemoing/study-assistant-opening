import { z } from "zod";
export const studySessionIntentSchema = z.object({
  purpose: z.enum(["confused", "self_study", "overview", "challenge", "review", "exam_sprint"]),
  timeBudgetMinutes: z.number().int().min(1).max(240), language: z.enum(["zh", "en", "bilingual"]),
  pace: z.enum(["slow", "normal", "fast"]), continuous: z.boolean(), selfReportedFatigue: z.enum(["unknown", "low", "high"]),
  explanationStyle: z.enum(["key_steps", "full"]).optional(),
  /** Explicit learner phase preference; absent on legacy sessions. */
  learningPhase: z.enum(["explore", "new_learning", "consolidate", "maintain"]).optional(),
}).strict();
export const studyIntentChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preference"), intent: studySessionIntentSchema }).strict(),
  z.object({ kind: z.literal("explicit_request"), text: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal("signal"), signal: z.enum(["confused", "too_easy", "guessed", "copied_answer"]) }).strict(),
]);
export const studyIntentEventInputSchema = z.object({ sessionId: z.string().uuid(), attemptId: z.string().uuid().optional(),
  clientKey: z.string().min(8).max(200), change: studyIntentChangeSchema }).strict();
export const studyIntentEventSchema = z.object({ id: z.string().uuid(), sessionId: z.string().uuid(), activityId: z.string().uuid(),
  attemptId: z.string().uuid().nullable(), version: z.number().int().positive(), change: studyIntentChangeSchema,
  intent: studySessionIntentSchema, signals: z.array(z.enum(["confused", "too_easy", "guessed", "copied_answer"])).max(4), action: z.enum(["continue", "diagnose", "increase_challenge", "clarify_intent"]), createdAt: z.string().datetime() }).strict();
export type StudyIntentChange = z.infer<typeof studyIntentChangeSchema>;
export type StudyIntentEventInput = z.infer<typeof studyIntentEventInputSchema>;
export type StudyIntentEvent = z.infer<typeof studyIntentEventSchema>;
