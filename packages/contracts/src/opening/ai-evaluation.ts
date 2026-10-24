import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

/** Model output is parsed before it can become a server-owned assessment. */
export const aiGradingProposalSchema = z.object({
  outcome: z.enum(["correct", "incorrect", "unverified"]),
  confidence: z.number().finite().min(0).max(1),
  questionMatch: z.boolean(),
  feedback: z.string().trim().min(1).max(6000),
  criteria: z.array(z.object({
    label: z.string().trim().min(1).max(300),
    verdict: z.enum(["correct", "incorrect", "unverified"]),
    feedback: z.string().trim().min(1).max(2000),
  }).strict()).min(1).max(30),
  transcription: z.string().max(20_000).optional(),
  /** Checked against the saved question's dictionary by the grading repository. */
  misconceptionId: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/).nullable().optional(),
  /** A teaching exercise only; its client-side answer never becomes mastery evidence. */
  followUp: z.object({
    prompt: z.string().trim().min(1).max(1200),
    options: z.array(z.object({ id: z.string().min(1).max(20), label: z.string().min(1).max(500) }).strict()).min(2).max(4),
    answerId: z.string().min(1).max(20),
    explanation: z.string().trim().min(1).max(2000),
  }).strict().refine(value => new Set(value.options.map(option => option.id)).size === value.options.length
    && value.options.some(option => option.id === value.answerId), "follow-up requires distinct options and a matching answer").optional(),
}).strict();

/** Only an existing saved answer is graded; the client never supplies its verdict. */
export const aiGradingInputSchema = z.object({
  observationId: uuidSchema,
  workSourceId: uuidSchema.optional(),
  workSourceVersion: z.number().int().nonnegative().optional(),
  physicalPage: z.number().int().positive().optional(),
}).strict().refine(input => input.workSourceId
  ? input.workSourceVersion !== undefined && input.physicalPage !== undefined
  : input.workSourceVersion === undefined && input.physicalPage === undefined,
"photo grading requires the source, captured version and physical page together");

/** Server-captured metadata revisions, not a learner/model assertion of answer authority. */
export const materialAssessmentRefSchema = z.object({
  sourceId: uuidSchema,
  sourceVersion: z.number().int().nonnegative(),
  manifestRevision: z.number().int().nonnegative(),
}).strict();
export const aiGradingMaterialProvenanceSchema = z.object({
  /** All applicable answer-link manifests consulted; only trusted answer text is used. */
  materialAnswerRefs: z.array(materialAssessmentRefSchema),
  /** Classification revisions of question/reference sources, including unclassified revision 0. */
  materialSourceRefs: z.array(materialAssessmentRefSchema),
}).strict();
export type AiGradingMaterialProvenance = z.infer<typeof aiGradingMaterialProvenanceSchema>;

export const aiEvaluationSchema = aiGradingProposalSchema.extend({
  observationId: uuidSchema,
  attemptId: uuidSchema,
  problemId: uuidSchema,
  itemVersionId: uuidSchema,
  requirementKey: z.string().min(1).max(200).nullable(),
  evaluatorVersion: z.literal("ai-rubric-v1"),
  modelLabel: z.string().min(1).max(300).nullable(),
  evaluatedAt: isoDateTimeSchema,
  /** Optional only for historical assessments; absence cannot prove current material authority. */
  materialAnswerRefs: aiGradingMaterialProvenanceSchema.shape.materialAnswerRefs.optional(),
  materialSourceRefs: aiGradingMaterialProvenanceSchema.shape.materialSourceRefs.optional(),
  /** Captured server-owned photo identity for reopening the assessed original. */
  workSource: z.object({
    id: uuidSchema, version: z.number().int().nonnegative(), physicalPage: z.number().int().positive(),
  }).strict().optional(),
}).strict();

export type AiGradingInput = z.infer<typeof aiGradingInputSchema>;
export type AiGradingProposal = z.infer<typeof aiGradingProposalSchema>;
export type AiEvaluation = z.infer<typeof aiEvaluationSchema>;

/** A photo is part of the submitted answer, not a browser-only grading option. */
export const aiGradingWorkSourceSchema = z.object({
  id: uuidSchema, version: z.number().int().nonnegative(), physicalPage: z.number().int().positive(),
}).strict();

export const aiGradingStatusSchema = z.object({
  rootObservationId: uuidSchema,
  headObservationId: uuidSchema,
  answerRevision: z.number().int().positive(),
  jobId: uuidSchema.nullable(),
  status: z.enum(["queued", "grading", "graded", "needs_manual", "unknown_cost"]),
  retryable: z.boolean(),
  workSource: aiGradingWorkSourceSchema.nullable(),
}).strict();
export type AiGradingStatus = z.infer<typeof aiGradingStatusSchema>;
export type AiGradingWorkSource = z.infer<typeof aiGradingWorkSourceSchema>;
