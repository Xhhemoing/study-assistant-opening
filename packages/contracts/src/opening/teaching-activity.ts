import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

export const teachingActivityIntentKindSchema = z.enum([
  "material",
  "topic",
  "question",
  "goal",
  "resume",
  "course_continue",
]);

export const teachingActivityStatusSchema = z.enum([
  "active",
  "paused",
  "completed",
  "skipped",
]);

export const teachingActivityGenerateStatusSchema = z.enum([
  "queued",
  "generating",
  "needs_check",
  "ready",
  "failed",
  "unknown",
  "cancelled",
  "stale",
]);

/** v2 create — courseId optional; clientKey + createIntent drive idempotency. */
export const teachingActivityCreateInputSchema = z
  .object({
    clientKey: z.string().min(8).max(200),
    intentKind: teachingActivityIntentKindSchema,
    intentSummary: z.string().min(1).max(2000),
    sourceIds: z.array(uuidSchema).max(32).optional(),
    courseId: uuidSchema.nullable().optional(),
    goalJson: z.record(z.string(), z.unknown()).optional(),
    createIntent: z.record(z.string(), z.unknown()),
  })
  .strict();

export const teachingActivitySchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    ownerUserId: uuidSchema,
    courseId: uuidSchema.nullable(),
    status: teachingActivityStatusSchema,
    generateStatus: teachingActivityGenerateStatusSchema,
    intentKind: teachingActivityIntentKindSchema,
    intentSummary: z.string().min(1).max(2000),
    sourceIds: z.array(uuidSchema).max(32),
    pathVersion: z.number().int().positive(),
    contentVersion: z.number().int().nonnegative(),
    checkpointJson: z.record(z.string(), z.unknown()).optional(),
    clientKey: z.string().min(8).max(200),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const teachingActivityAssociateCourseInputSchema = z
  .object({
    courseId: uuidSchema.nullable(),
    expectedUpdatedAt: isoDateTimeSchema.optional(),
  })
  .strict();

/**
 * Sketch for v2 observation adapters (formal writes still go through observation services).
 * activityId required; courseId optional and must match association rules when set.
 */
export const activityObservationInputSketchSchema = z
  .object({
    activityId: uuidSchema,
    sessionId: uuidSchema,
    courseId: uuidSchema.nullable().optional(),
  })
  .strict();

export type TeachingActivityIntentKind = z.infer<typeof teachingActivityIntentKindSchema>;
export type TeachingActivityStatus = z.infer<typeof teachingActivityStatusSchema>;
export type TeachingActivityGenerateStatus = z.infer<typeof teachingActivityGenerateStatusSchema>;
export type TeachingActivityCreateInput = z.infer<typeof teachingActivityCreateInputSchema>;
export type TeachingActivity = z.infer<typeof teachingActivitySchema>;
export type TeachingActivityAssociateCourseInput = z.infer<
  typeof teachingActivityAssociateCourseInputSchema
>;
