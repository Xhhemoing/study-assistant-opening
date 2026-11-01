import { studyContextAnchorSchema } from "./tutor";
import { spanExerciseInputSchema, spanProblemSchema } from "./span-learning";
import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { assistanceLevelSchema, observationOutcomeSchema, publicVerdictSourceSchema } from "./learning";
import { referenceCheckInputSchema, sourceVersionsSchema } from "./learning-evidence";
import { matrixExerciseInputSchema, matrixExerciseSpecSchema } from "./matrix-evaluation";
import { aiGradingWorkSourceSchema } from "./ai-evaluation";

export const learningAttemptProblemInputSchema = z.object({
  sourceId: uuidSchema.optional(),
  physicalPage: z.number().int().positive().nullable().optional(),
  chunkId: uuidSchema.nullable().optional(),
  stemSnapshot: z.string().trim().min(1).max(2000),
  artifactKind: z.enum(["reference_item", "student_work", "unknown"]),
}).strict().refine(input => Boolean(input.sourceId) || (input.physicalPage == null && input.chunkId == null),
  "page and chunk require a material source");
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
/** Ordinal learner self-report, not a probability or mastery evidence. */
export const preAnswerConfidenceSchema = z.enum(["not_confident", "somewhat_confident", "confident"]);
export const learningAttemptSubmitInputSchema = z.object({
  clientKey: z.string().min(8).max(200), answer: z.string().max(20_000),
  outcome: observationOutcomeSchema, assistance: assistanceLevelSchema,
  verdictSource: publicVerdictSourceSchema.optional(), referenceSourceId: uuidSchema.nullable().optional(),
  referenceCheck: referenceCheckInputSchema.optional(), retestId: uuidSchema.nullable().optional(),
  workSource: aiGradingWorkSourceSchema.optional(),
  preAnswerConfidence: preAnswerConfidenceSchema.nullable().optional(),
}).strict();
export const courseRequirementBindingSchema = z.object({ id: uuidSchema, revision: z.number().int().positive(),
  stableSkillId: uuidSchema, requirementKey: z.string().trim().min(1).max(200) }).strict();
export const learningAttemptSchema = z.object({
  id: uuidSchema, workspaceId: uuidSchema, sessionId: uuidSchema, courseId: uuidSchema,
  skillLabel: z.string(), requirementKey: z.string().nullable(),
  problemId: uuidSchema.nullable(), itemVersionId: uuidSchema.nullable(),
  courseRequirement: courseRequirementBindingSchema.optional(),
  stemSnapshot: z.string().min(1).refine(value => Array.from(value).length <= 2000, "question snapshot exceeds 2000 characters").optional(),
  sourceIds: z.array(uuidSchema), sourceVersions: sourceVersionsSchema,
  startedAt: isoDateTimeSchema, submittedAt: isoDateTimeSchema.nullable(),
  observationId: uuidSchema.nullable(), historyRevision: z.number().int().nonnegative(),
  preAnswerConfidence: preAnswerConfidenceSchema.nullable().optional(),
  contextAnchor: studyContextAnchorSchema.optional(),
  spanExercise: spanProblemSchema.optional(),
  spanPracticeOriginAttemptId: uuidSchema.optional(),
  spanValidation: z.object({ eligible: z.boolean(), firstFamilyExposure: z.boolean(), reasonCode: z.string().nullable() }).strict().optional(),
  matrixExercise: matrixExerciseSpecSchema.optional(),
}).strict();
/** A resumable context binds an owned, saved question version. */
export const learningAttemptContextReadSchema = z.object({
  attempt: learningAttemptSchema,
  deliveredAssistance: z.enum(["none", "hinted", "revealed"]),
}).strict().refine(({ attempt }) => {
  const anchor = attempt.contextAnchor;
  return Boolean(attempt.problemId && attempt.itemVersionId && anchor?.activityId
    && anchor.attemptId === attempt.id && anchor.courseId === attempt.courseId
    && anchor.itemVersionId === attempt.itemVersionId
    && (anchor.sourceId ? attempt.sourceIds.includes(anchor.sourceId) && anchor.sourceVersion != null
      && attempt.sourceVersions[anchor.sourceId] === anchor.sourceVersion
      : anchor.sourceVersion == null
        && (anchor.blockId ? anchor.contentVersion != null
          && (attempt.requirementKey === `teaching:${anchor.blockId}:v${anchor.contentVersion}`
            || (attempt.courseRequirement !== undefined && attempt.requirementKey === attempt.courseRequirement.requirementKey))
          : anchor.contentVersion == null && Boolean(attempt.stemSnapshot))
        && attempt.sourceIds.every(id => Number.isInteger(attempt.sourceVersions[id]))));
}, "assistant context requires a canonical attempt and saved question version");
export type LearningAttemptContextRead = z.infer<typeof learningAttemptContextReadSchema>;
export type LearningAttempt = z.infer<typeof learningAttemptSchema>;
export type LearningAttemptCreateInput = z.infer<typeof learningAttemptCreateInputSchema>;
export type LearningAttemptSubmitInput = z.infer<typeof learningAttemptSubmitInputSchema>;
