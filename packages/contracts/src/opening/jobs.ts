import { z } from "zod";
import { apiFailureSchema, isoDateTimeSchema, uuidSchema } from "./foundation";

export const jobKindSchema = z.enum(["parse", "tutor", "retest", "remind", "build-course-knowledge", "parse-media", "extract-study-actions"]);
export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
]);

export const jobRecordSchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    key: z.string().min(1).max(200),
    kind: jobKindSchema,
    status: jobStatusSchema,
    attempt: z.number().int().nonnegative(),
    error: apiFailureSchema.nullable(),
    privacyEpoch: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Terminal tutor job error. `nextAction: "clarify"` marks a fail-closed
 * refusal that must route the learner to the Clarify path (pick the
 * material/page) instead of a generic failure (LAB-A01 require_page).
 */
export const tutorJobErrorSchema = z
  .object({
    message: z.string().min(1),
    code: z.string().min(1).max(64).optional(),
    nextAction: z.enum(["clarify"]).optional(),
  })
  .strict();

export const jobStatusResponseSchema = z
  .object({
    id: uuidSchema,
    status: jobStatusSchema,
    error: tutorJobErrorSchema.nullable(),
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type JobKind = z.infer<typeof jobKindSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type JobRecord = z.infer<typeof jobRecordSchema>;
export type JobStatusResponse = z.infer<typeof jobStatusResponseSchema>;
export type TutorJobError = z.infer<typeof tutorJobErrorSchema>;
