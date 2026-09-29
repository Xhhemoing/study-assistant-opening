import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { assistanceLevelSchema, observationOutcomeSchema, verdictSourceSchema } from "./learning";
import { referenceCheckInputSchema, sourceVersionsSchema } from "./learning-evidence";

export const learningAttemptProblemInputSchema = z.object({
  sourceId: uuidSchema,
  physicalPage: z.number().int().positive().nullable().optional(),
  chunkId: uuidSchema.nullable().optional(),
  stemSnapshot: z.string().trim().min(1).max(2000),
  artifactKind: z.enum(["reference_item", "student_work", "unknown"]),
}).strict();
export const learningAttemptCreateInputSchema = z.object({
  sessionId: uuidSchema, clientKey: z.string().min(8).max(200),
  problemId: uuidSchema.nullable().optional(), problem: learningAttemptProblemInputSchema.optional(),
  requirementKey: z.string().trim().min(1).max(200).nullable().optional(),
}).strict().refine((input) => !(input.problemId && input.problem), "choose an existing problem or a new problem");
export const learningAttemptSubmitInputSchema = z.object({
  clientKey: z.string().min(8).max(200), answer: z.string().max(20_000),
  outcome: observationOutcomeSchema, assistance: assistanceLevelSchema,
  verdictSource: verdictSourceSchema.optional(), referenceSourceId: uuidSchema.nullable().optional(),
  referenceCheck: referenceCheckInputSchema.optional(), retestId: uuidSchema.nullable().optional(),
}).strict();
export const learningAttemptSchema = z.object({
  id: uuidSchema, workspaceId: uuidSchema, sessionId: uuidSchema, courseId: uuidSchema,
  skillLabel: z.string(), requirementKey: z.string().nullable(),
  problemId: uuidSchema.nullable(), itemVersionId: uuidSchema.nullable(),
  sourceIds: z.array(uuidSchema), sourceVersions: sourceVersionsSchema,
  startedAt: isoDateTimeSchema, submittedAt: isoDateTimeSchema.nullable(),
  observationId: uuidSchema.nullable(), historyRevision: z.number().int().nonnegative(),
}).strict();
export type LearningAttempt = z.infer<typeof learningAttemptSchema>;
export type LearningAttemptCreateInput = z.infer<typeof learningAttemptCreateInputSchema>;
export type LearningAttemptSubmitInput = z.infer<typeof learningAttemptSubmitInputSchema>;
