import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

const nullableTimeSchema = isoDateTimeSchema.nullable();

export const retestActivityStatusSchema = z.enum([
  "proposed",
  "accepted",
  "in_progress",
  "completed",
  "declined",
  "cancelled",
  "invalidated",
  "superseded",
]);

export const retestActivityResultSchema = z.enum([
  "correct",
  "incorrect",
  "unverified",
]);

export const retestActivityTimesSchema = z
  .object({
    proposedAt: nullableTimeSchema,
    acceptedAt: nullableTimeSchema,
    startedAt: nullableTimeSchema,
    completedAt: nullableTimeSchema,
    declinedAt: nullableTimeSchema,
    cancelledAt: nullableTimeSchema,
    invalidatedAt: nullableTimeSchema,
    supersededAt: nullableTimeSchema,
    notBeforeAt: nullableTimeSchema,
    recommendedAt: nullableTimeSchema,
    scheduledStartAt: nullableTimeSchema,
    deadlineAt: nullableTimeSchema,
  })
  .strict();

export const retestActivitySchema = z
  .object({
    activityId: uuidSchema,
    cycleId: uuidSchema,
    /** Business identity is optional for legacy lifecycle snapshots. */
    courseId: uuidSchema.optional(),
    skillLabel: z.string().min(1).max(200).optional(),
    requirementKey: z.string().max(200).nullable().optional(),
    purpose: z.literal("retest").optional(),
    status: retestActivityStatusSchema,
    result: retestActivityResultSchema.nullable(),
    taskId: uuidSchema.nullable(),
    candidateId: uuidSchema.nullable(),
    version: z.number().int().positive(),
    snoozedUntil: nullableTimeSchema,
    reason: z.string().min(1).max(200).nullable(),
    reopenedFromActivityId: uuidSchema.nullable(),
    times: retestActivityTimesSchema,
  })
  .strict();

export type RetestActivityStatus = z.infer<typeof retestActivityStatusSchema>;
export type RetestActivityResult = z.infer<typeof retestActivityResultSchema>;
export type RetestActivityTimes = z.infer<typeof retestActivityTimesSchema>;
export type RetestActivity = z.infer<typeof retestActivitySchema> & {
  result: RetestActivityResult | null;
};
