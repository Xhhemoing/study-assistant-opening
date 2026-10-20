import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { spanVerificationSkillsSchema } from "./span-learning";

export const matrixExerciseKeySchema = z.enum(["dimensions", "addition", "scalar", "multiplication"]);
export const matrixExerciseInputSchema = z.object({
  sourceId: uuidSchema,
  exerciseKey: matrixExerciseKeySchema,
  variant: z.number().int().min(0).max(8).default(0),
}).strict();
const integerMatrixSchema = z.array(z.array(z.number().int().min(-100).max(100)).min(1).max(4)).min(1).max(4);
/** Immutable, server-generated question operands. Contains no reference answer. */
export const matrixExerciseSpecSchema = z.object({
  kind: z.literal("matrix_arithmetic"),
  specVersion: z.literal("matrix-arithmetic-v1"),
  exerciseKey: matrixExerciseKeySchema,
  variant: z.number().int().min(0).max(8),
  matrixA: integerMatrixSchema,
  matrixB: integerMatrixSchema.optional(),
  scalar: z.string().regex(/^-?\d+(?:\/[1-9]\d*)?$/).max(20).optional(),
}).strict();
/** Catalogue identity only. Answers remain in the server's frozen exam pack. */
export const examChoiceSpecSchema = z.object({
  kind: z.literal("exam_choice"), specVersion: z.literal("exam-choice-v1"),
  packId: z.string().min(1).max(100), packVersion: z.string().min(1).max(100),
  questionId: z.string().min(1).max(100), familyId: z.string().min(1).max(100),
}).strict();

const serverEvaluationFacts = {
  observationId: uuidSchema, attemptId: uuidSchema, problemId: uuidSchema, itemVersionId: uuidSchema,
  requirementKey: z.string().min(1).max(200),
  decision: z.enum(["correct", "incorrect", "abstain"]),
  outcome: z.enum(["correct", "incorrect", "unverified"]),
  reasonCodes: z.array(z.string().min(1)).min(1).max(8),
  evaluatedAt: isoDateTimeSchema,
};
/** Each evaluator is paired with its exact supported spec, never an arbitrary deterministic label. */
export const serverEvaluationSchema = z.discriminatedUnion("evaluatorVersion", [
  z.object({ ...serverEvaluationFacts, evaluatorVersion: z.literal("matrix-exact-v1"), specVersion: z.literal("matrix-arithmetic-v1") }).strict(),
  z.object({ ...serverEvaluationFacts, evaluatorVersion: z.literal("exam-choice-exact-v1"), specVersion: z.literal("exam-choice-v1") }).strict(),
  z.object({ ...serverEvaluationFacts, evaluatorVersion: z.literal("span-exact-v1"), specVersion: z.literal("span-v1"), skills: spanVerificationSkillsSchema.optional(), coreEvidenceComplete: z.boolean().default(false), membershipOutcome: z.enum(["correct", "incorrect", "unobserved"]).optional() }).strict(),
]);

export type MatrixExerciseInput = z.infer<typeof matrixExerciseInputSchema>;
export type MatrixExerciseSpec = z.infer<typeof matrixExerciseSpecSchema>;
export type ExamChoiceSpec = z.infer<typeof examChoiceSpecSchema>;
export type ServerEvaluation = z.infer<typeof serverEvaluationSchema>;
