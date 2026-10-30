import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { studySessionIntentSchema } from "./study-session-intent";
export type LearningAgendaStatus = z.infer<typeof learningAgendaStatusSchema>;
export type LearningAgendaMode = z.infer<typeof learningAgendaModeSchema>;

export const learningAgendaStatusSchema = z.enum(["active", "paused", "completed", "cancelled", "deferred", "unknown"]);
export const learningAgendaModeSchema = z.enum(["diagnose", "targeted_explain", "full_explain", "reduced_help_practice", "transfer_check", "unknown"]);
export const learningAgendaSchema = z.object({
  courseId: uuidSchema,
  goalId: uuidSchema.nullable(),
  activityId: uuidSchema.nullable(),
  sessionId: uuidSchema.nullable(),
  itemVersionId: uuidSchema.nullable(),
  status: learningAgendaStatusSchema,
  mode: learningAgendaModeSchema,
  userOverride: z.string().max(200).nullable(),
  help: z.object({ delivered: z.boolean(), level: z.enum(["none", "hinted", "revealed", "unknown"]) }).strict(),
  requirement: z.string().max(200).nullable(),
  selectedAction: z.string().max(200).nullable(),
  returnTo: z.string().max(2000).nullable(),
  originActivityId: uuidSchema.nullable(),
  pendingRetestId: uuidSchema.nullable(),
  parentDecisionId: uuidSchema.nullable(),
  decisionCurrent: z.boolean().nullable(),
  invalidationReasons: z.array(z.string().max(300)).max(16),
  intent: studySessionIntentSchema.nullable(),
  moveId: z.string().nullable(),
  budget: z.record(z.string(), z.unknown()).nullable(),
  decisionId: uuidSchema.nullable(),
  resumable: z.boolean(),
  suggestion: z.object({ activityKind: z.string(), focusObservationId: uuidSchema.nullable(), reasonCode: z.string() }).passthrough().nullable(),
  dataAsOf: isoDateTimeSchema,
}).strict();
export type LearningAgenda = z.infer<typeof learningAgendaSchema>;
export type LearningAgendaInput = Omit<LearningAgenda, "dataAsOf"> & { dataAsOf?: string };
