import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

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
export const serverEvaluationSchema = z.object({
  observationId: uuidSchema, attemptId: uuidSchema, problemId: uuidSchema, itemVersionId: uuidSchema,
  requirementKey: z.string().min(1).max(200),
  evaluatorVersion: z.literal("matrix-exact-v1"), specVersion: z.literal("matrix-arithmetic-v1"),
  decision: z.enum(["correct", "incorrect", "abstain"]),
  outcome: z.enum(["correct", "incorrect", "unverified"]),
  reasonCodes: z.array(z.string().min(1)).min(1).max(8),
  evaluatedAt: isoDateTimeSchema,
}).strict();

export type MatrixExerciseInput = z.infer<typeof matrixExerciseInputSchema>;
export type MatrixExerciseSpec = z.infer<typeof matrixExerciseSpecSchema>;
export type ServerEvaluation = z.infer<typeof serverEvaluationSchema>;
