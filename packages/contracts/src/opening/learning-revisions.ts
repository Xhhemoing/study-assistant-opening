import { z } from "zod";
import { uuidSchema } from "./foundation";
import { assistanceLevelSchema, learningObservationSchema, observationOutcomeSchema, publicVerdictSourceSchema } from "./learning";
import { referenceCheckInputSchema } from "./learning-evidence";
import { studyExposureReceiptSchema } from "./tutor";

export const observationReplacementSchema = z.object({
  answer: z.string().max(20_000), outcome: observationOutcomeSchema, assistance: assistanceLevelSchema,
  courseId: uuidSchema.optional(), skillLabel: z.string().trim().min(1).max(200).optional(),
  requirementKey: z.string().max(200).nullable().optional(), verdictSource: publicVerdictSourceSchema.optional(),
  referenceSourceId: uuidSchema.nullable().optional(), referenceCheck: referenceCheckInputSchema.optional(),
}).strict();
const operation = {
  rootObservationId: uuidSchema, revisesObservationId: uuidSchema, expectedHead: uuidSchema,
  reason: z.string().trim().min(1).max(2000), clientKey: z.string().min(8).max(200),
};
export const observationRevisionInputSchema = z.discriminatedUnion("revisionKind", [
  z.object({ ...operation, revisionKind: z.literal("replace"), replacement: observationReplacementSchema }).strict(),
  z.object({ ...operation, revisionKind: z.literal("retract") }).strict(),
]);
export const observationRevisionResultSchema = z.object({
  disposition: z.enum(["applied", "replayed"]), rootObservationId: uuidSchema, headObservationId: uuidSchema,
  revisionKind: z.enum(["replace", "retract"]), observation: learningObservationSchema.nullable(),
  historyRevision: z.number().int().nonnegative(),
}).strict();
export const observationHistorySchema = z.object({
  rootObservationId: uuidSchema, headObservationId: uuidSchema, revisions: z.array(learningObservationSchema),
  // HTTP history delivery adds receipts; repository reads have not released content.
  exposureReceipts: z.array(studyExposureReceiptSchema).optional(),
}).strict();
export type ObservationRevisionInput = z.infer<typeof observationRevisionInputSchema>;
export type ObservationRevisionResult = z.infer<typeof observationRevisionResultSchema>;
export type ObservationHistory = z.infer<typeof observationHistorySchema>;
