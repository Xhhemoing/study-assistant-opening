import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

export const sourceVersionsSchema = z.record(uuidSchema, z.number().int().nonnegative());
export const evidenceEligibilitySchema = z.object({
  independentAttempt: z.enum(["yes", "no", "unknown"]),
  verifiedCorrect: z.enum(["yes", "no", "unknown"]),
  usableForCurrentVersion: z.enum(["yes", "no", "unknown"]),
  usableForDelayedCheck: z.enum(["yes", "no", "unknown"]),
  reasonCodes: z.array(z.string().min(1)),
  policyVersion: z.literal("opening-evidence-v1"),
}).strict();
export const referenceCheckInputSchema = z.object({
  referenceSourceId: uuidSchema,
  method: z.string().trim().min(1).max(500),
  scope: z.enum(["whole_answer", "partial", "unknown"]),
}).strict();
export const referenceCheckFactSchema = z.object({
  attemptId: uuidSchema.nullable(), problemId: uuidSchema.nullable(), itemVersionId: uuidSchema.nullable(),
  referenceId: uuidSchema, method: z.string(), scope: z.enum(["whole_answer", "partial", "unknown"]),
  checkerId: uuidSchema, outcome: z.enum(["correct", "incorrect", "unverified"]),
}).strict();
export const learningObservationFactsShape = {
  attemptId: uuidSchema.nullable().optional(), itemVersionId: uuidSchema.nullable().optional(),
  requirementKey: z.string().max(200).nullable().optional(),
  startedAt: isoDateTimeSchema.nullable().optional(), submittedAt: isoDateTimeSchema.nullable().optional(),
  recordedAt: isoDateTimeSchema.nullable().optional(), sourceVersions: sourceVersionsSchema.nullable().optional(),
  historyRevision: z.number().int().nonnegative().optional(),
  referenceCheck: referenceCheckFactSchema.nullable().optional(), eligibility: evidenceEligibilitySchema.optional(),
};
export type LearningEvidenceEligibility = z.infer<typeof evidenceEligibilitySchema>;
export type LearningReferenceCheck = z.infer<typeof referenceCheckFactSchema>;
