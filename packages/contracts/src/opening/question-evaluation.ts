import { z } from "zod";
import { isoDateTimeSchema, scopeSchema, uuidSchema } from "./foundation";
import { courseRouteActivityContextSchema } from "./course-route";
import { privateTrustedQuestionKeySchema } from "./question-identity";

export const QUESTION_EVALUATION_PROTOCOL = "question-evaluation-1" as const;

/** Stable within the immutable question revision; do not derive from display order. */
export const questionPartBindingSchema = z.object({
  partId: z.string().trim().min(1).max(100),
  requirementKey: courseRouteActivityContextSchema.shape.requirementKey,
  /** Exact identity of this part, not an inferred sibling/whole-question identity. */
  identityRefId: uuidSchema,
}).strict();

export const questionPartOutcomeSchema = z.enum(["correct", "incorrect", "unknown"]);
export const questionPartAssistanceSchema = z.enum(["independent", "hinted", "revealed", "unknown"]);

export const questionPartEvaluationSchema = questionPartBindingSchema.extend({
  outcome: questionPartOutcomeSchema,
  assistance: questionPartAssistanceSchema,
}).strict();

/**
 * PRIVATE server evaluation snapshot, not a submission/authorization schema.
 * Publish every declared part with unknown for missing/ungraded work; partId mappings
 * must be resolved against the immutable question, not accepted from a browser.
 * Correctness and assistance are orthogonal: a revealed correct part remains assisted.
 * No aggregate credit: a partial/unknown/assisted part must not change siblings, and
 * this snapshot never replaces or recalculates the original whole-question timed score.
 */
export const questionEvaluationSchema = z.object({
  protocolVersion: z.literal(QUESTION_EVALUATION_PROTOCOL),
  evaluationRefId: uuidSchema,
  questionIdentityRefId: uuidSchema,
  parts: z.array(questionPartEvaluationSchema).min(1).max(64),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.parts.forEach((part, index) => {
    if (seen.has(part.partId)) {
      ctx.addIssue({ code: "custom", path: ["parts", index, "partId"], message: "Duplicate partId" });
    }
    seen.add(part.partId);
  });
});

/**
 * PRIVATE scoped ledger receipt, NOT a browser's claim of being unseen. The server must
 * resolve its identity, scope and history revision (including equivalent exact identities,
 * hints/solutions/examples and unknown coverage) at use time. A stale or incomplete ledger
 * cannot establish unexposed status, even when this shape parses successfully.
 */
export const questionUnexposedReceiptSchema = scopeSchema.extend({
  receiptId: uuidSchema,
  identityRefId: uuidSchema,
  historyRevision: z.number().int().nonnegative(),
  checkedAt: isoDateTimeSchema,
  status: z.literal("unexposed"),
}).strict();

/**
 * PRIVATE retained-question eligibility only; not an independent-credit verdict.
 * Ready needs an exact registry identity, immutable trusted key and server-checkable
 * unexposed receipt for the SAME identity. Identity matching alone is never sufficient.
 * Unknown/missing evidence stays unknown/unavailable, never silently treated as unseen.
 * Schemas establish shapes, not authorization: server resolution is mandatory before use.
 */
export const retainedQuestionEligibilitySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    identityStatus: z.literal("exact"),
    trustedKey: privateTrustedQuestionKeySchema,
    exposure: questionUnexposedReceiptSchema,
  }).strict(),
  z.object({
    status: z.literal("unknown"),
    reason: z.enum(["identity_unknown", "identity_candidate", "key_unknown", "exposure_unknown", "coverage_unknown"]),
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum(["identity_conflict", "key_unavailable", "reference_unavailable", "exposed", "stale_receipt"]),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.status === "ready" && value.trustedKey.identity.identityRefId !== value.exposure.identityRefId) {
    ctx.addIssue({ code: "custom", path: ["exposure", "identityRefId"], message: "Unexposed receipt must bind the trusted key identity" });
  }
});

export type QuestionPartBinding = z.infer<typeof questionPartBindingSchema>;
export type QuestionPartOutcome = z.infer<typeof questionPartOutcomeSchema>;
export type QuestionPartAssistance = z.infer<typeof questionPartAssistanceSchema>;
export type QuestionPartEvaluation = z.infer<typeof questionPartEvaluationSchema>;
export type QuestionEvaluation = z.infer<typeof questionEvaluationSchema>;
export type QuestionUnexposedReceipt = z.infer<typeof questionUnexposedReceiptSchema>;
export type RetainedQuestionEligibility = z.infer<typeof retainedQuestionEligibilitySchema>;
