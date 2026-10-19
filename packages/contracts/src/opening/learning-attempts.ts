import { studyContextAnchorSchema } from "./tutor";
import { spanExerciseInputSchema, spanProblemSchema } from "./span-learning";
import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { assistanceLevelSchema, observationOutcomeSchema, publicVerdictSourceSchema } from "./learning";
import { referenceCheckInputSchema, sourceVersionsSchema } from "./learning-evidence";
import { matrixExerciseInputSchema, matrixExerciseSpecSchema } from "./matrix-evaluation";

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
  teachingBlock: z.object({ blockId: uuidSchema, contentVersion: z.number().int().positive() }).strict().optional(),
  requirementKey: z.string().trim().min(1).max(200).nullable().optional(),
  contextAnchor: studyContextAnchorSchema.optional(),
  spanExercise: spanExerciseInputSchema.optional(),
  matrixExercise: matrixExerciseInputSchema.optional(),
}).strict().refine((input) => !(input.problemId && input.problem), "choose an existing problem or a new problem")
  .refine(input => !input.spanExercise || !(input.matrixExercise || input.problemId || input.problem || input.teachingBlock || input.requirementKey), "span exercise sets its own question and requirement")
  .refine(input => !input.matrixExercise || !(input.problemId || input.problem || input.teachingBlock || input.requirementKey), "matrix exercise sets its own question and requirement");
export const learningAttemptSubmitInputSchema = z.object({
  clientKey: z.string().min(8).max(200), answer: z.string().max(20_000),
  outcome: observationOutcomeSchema, assistance: assistanceLevelSchema,
  verdictSource: publicVerdictSourceSchema.optional(), referenceSourceId: uuidSchema.nullable().optional(),
  referenceCheck: referenceCheckInputSchema.optional(), retestId: uuidSchema.nullable().optional(),
}).strict();
export const learningAttemptSchema = z.object({
  id: uuidSchema, workspaceId: uuidSchema, sessionId: uuidSchema, courseId: uuidSchema,
  skillLabel: z.string(), requirementKey: z.string().nullable(),
  problemId: uuidSchema.nullable(), itemVersionId: uuidSchema.nullable(),
  sourceIds: z.array(uuidSchema), sourceVersions: sourceVersionsSchema,
  startedAt: isoDateTimeSchema, submittedAt: isoDateTimeSchema.nullable(),
  observationId: uuidSchema.nullable(), historyRevision: z.number().int().nonnegative(),
  contextAnchor: studyContextAnchorSchema.optional(),
  spanExercise: spanProblemSchema.optional(),
  spanValidation: z.object({ eligible: z.boolean(), firstFamilyExposure: z.boolean(), reasonCode: z.string().nullable() }).strict().optional(),
  matrixExercise: matrixExerciseSpecSchema.optional(),
}).strict();
export type LearningAttempt = z.infer<typeof learningAttemptSchema>;
export type LearningAttemptCreateInput = z.infer<typeof learningAttemptCreateInputSchema>;
export type LearningAttemptSubmitInput = z.infer<typeof learningAttemptSubmitInputSchema>;
