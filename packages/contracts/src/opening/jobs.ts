import { z } from "zod";
import { apiFailureSchema, isoDateTimeSchema, uuidSchema } from "./foundation";

export const jobKindSchema = z.enum(["parse", "tutor", "retest", "remind"]);
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

export const jobStatusResponseSchema = z
  .object({
    id: uuidSchema,
    status: jobStatusSchema,
    error: z.object({ message: z.string().min(1) }).strict().nullable(),
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type JobKind = z.infer<typeof jobKindSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type JobRecord = z.infer<typeof jobRecordSchema>;
export type JobStatusResponse = z.infer<typeof jobStatusResponseSchema>;
