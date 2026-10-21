import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { studySessionIntentSchema } from "./study-session-intent";

export const spanLessonMoveIdSchema = z.enum([
  "self-example", "self-faded", "self-independent", "self_study-reserved",
  "overview-links", "overview-contrast", "overview-mixed", "overview-reserved",
  "challenge-predict", "challenge-transfer", "challenge-reserved",
]);
export const spanLessonCreateInputSchema = z.object({
  courseId: uuidSchema,
  sourceIds: z.array(uuidSchema).min(1).max(32).refine(ids => new Set(ids).size === ids.length, "duplicate source"),
  intent: studySessionIntentSchema,
  clientKey: z.string().min(8).max(160),
  retestId: uuidSchema.nullable().optional(),
}).strict();
export const spanLessonSaveInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  intent: studySessionIntentSchema,
  moveId: spanLessonMoveIdSchema,
  status: z.enum(["active", "paused", "completed"]),
}).strict();
export const spanLessonSnapshotSchema = z.object({
  activityId: uuidSchema,
  sessionId: uuidSchema,
  courseId: uuidSchema,
  sourceIds: z.array(uuidSchema).min(1).max(32),
  intent: studySessionIntentSchema,
  moveId: spanLessonMoveIdSchema,
  status: z.enum(["active", "paused", "completed"]),
  revision: z.number().int().positive(),
  retestId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict();
export type SpanLessonCreateInput = z.infer<typeof spanLessonCreateInputSchema>;
export type SpanLessonSaveInput = z.infer<typeof spanLessonSaveInputSchema>;
export type SpanLessonSnapshot = z.infer<typeof spanLessonSnapshotSchema>;
