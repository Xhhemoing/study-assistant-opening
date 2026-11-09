import { z } from "zod";
import { uuidSchema } from "./foundation";

export const spanRepairTargetSchema = z.enum(["equation", "coefficients", "allCoordinates"]);
export type SpanRepairTarget = z.infer<typeof spanRepairTargetSchema>;
const sourceRefSchema = z.object({ sourceId: uuidSchema, sourceVersion: z.number().int().nonnegative() }).strict();
export const spanRepairEvidenceSchema = z.object({
  observationId: uuidSchema, rootObservationId: uuidSchema, attemptId: uuidSchema,
  problemId: uuidSchema, itemVersionId: uuidSchema,
  sourceRefs: z.array(sourceRefSchema).min(1).max(960),
  evaluatorVersion: z.literal("span-exact-v1"), specVersion: z.literal("span-v1"),
}).strict();
export type SpanRepairEvidence = z.infer<typeof spanRepairEvidenceSchema>;
const itemSchema = z.object({ problemId: z.string().min(1).max(100), version: z.string().min(1).max(30) }).strict();
const prerequisiteSchema = z.object({ status: z.literal("unknown"), reasonCode: z.literal("prerequisite_binding_missing") }).strict();
export const spanRepairClarificationReasonSchema = z.enum([
  "evidence_unavailable", "verification_mismatch", "predecessor_unobserved", "ambiguous_branch",
  "unsupported_target", "no_verified_error", "teaching_unavailable", "unknown_history",
]);
export type SpanRepairClarificationReason = z.infer<typeof spanRepairClarificationReasonSchema>;
/** Server-owned JSON. Do not serialize this plan into lesson or presentation responses. */
export const spanRepairPlanSchema = z.discriminatedUnion("status", [
  z.object({ version: z.literal(1), contentVersion: z.literal(1), status: z.literal("ready"),
    basis: spanRepairEvidenceSchema, targetSkill: spanRepairTargetSchema,
    diagnosticBasis: z.literal("first_verified_dependency_step"), prerequisite: prerequisiteSchema,
    teachingExample: itemSchema, practiceVariant: itemSchema,
    returnMoveId: z.literal("self_study-reserved"),
  }).strict(),
  z.object({ version: z.literal(1), contentVersion: z.literal(1), status: z.literal("needs_clarification"),
    reasonCode: spanRepairClarificationReasonSchema, prerequisite: prerequisiteSchema,
  }).strict(),
]);
export type SpanRepairPlan = z.infer<typeof spanRepairPlanSchema>;
/** Only current-stage content is public; candidate identities and future answers stay server-side. */
export const spanRepairContextSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), version: z.literal(1), contentVersion: z.literal(1),
    targetSkill: spanRepairTargetSchema, focusSummary: z.string().min(1), prerequisiteStatus: z.literal("unknown"),
  }).strict(),
  z.object({ status: z.literal("needs_clarification"), version: z.literal(1),
    reasonCode: spanRepairClarificationReasonSchema, message: z.string().min(1), prerequisiteStatus: z.literal("unknown"),
  }).strict(),
]);
export type SpanRepairContext = z.infer<typeof spanRepairContextSchema>;
export const spanTargetedExplanationSchema = z.object({ targetSkill: spanRepairTargetSchema,
  brief: z.string().min(1), workedSteps: z.array(z.object({ label: z.string().min(1), math: z.string().min(1) }).strict()).min(1),
  stopCondition: z.string().min(1),
}).strict();
export type SpanTargetedExplanation = z.infer<typeof spanTargetedExplanationSchema>;
export const spanRepairPresentationInputSchema = z.object({ activityId: uuidSchema, repairVersion: z.literal(1),
  stage: z.literal("example"), clientKey: z.string().min(8).max(160),
}).strict();
export const spanRepairIssueInputSchema = z.object({ activityId: uuidSchema, repairVersion: z.literal(1),
  expectedRevision: z.number().int().positive(), stage: z.enum(["variant", "confirmation"]),
  clientKey: z.string().min(8).max(160),
  /** Explicit same-item retry; the server derives its identity from this currently authorized parent. */
  retryAfterAttemptId: uuidSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.retryAfterAttemptId && input.stage !== "variant") ctx.addIssue({ code: "custom", path: ["retryAfterAttemptId"], message: "Only the current teaching variant accepts a same-item retry" });
});
