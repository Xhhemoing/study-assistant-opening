import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { assistanceLevelSchema } from "./learning";
import { goalLearningContextSchema, prerequisiteRepairSchema } from "./goal-learning";

export const teachingActivityIntentKindSchema = z.enum([
  "material",
  "topic",
  "question",
  "goal",
  "resume",
  "course_continue",
]);

export const teachingActivityStatusSchema = z.enum([
  "active",
  "paused",
  "completed",
  "skipped",
]);

export const teachingActivityGenerateStatusSchema = z.enum([
  "queued",
  "generating",
  "needs_check",
  "ready",
  "failed",
  "unknown",
  "cancelled",
  "stale",
]);

/** v2 create — courseId optional; clientKey + createIntent drive idempotency. */
export const teachingActivityCreateInputSchema = z
  .object({
    clientKey: z.string().min(8).max(200),
    /** Server validates this user turn before sharing its parent interaction budget. */
    sourceTurnId: uuidSchema.optional(),
    intentKind: teachingActivityIntentKindSchema,
    intentSummary: z.string().min(1).max(2000),
    sourceIds: z.array(uuidSchema).max(32).optional(),
    courseId: uuidSchema.nullable().optional(),
    goalJson: z.record(z.string(), z.unknown()).optional(),
    createIntent: z.record(z.string(), z.unknown()),
    /**
     * When the clientKey already names a completed activity, start the next one in
     * its chain (`<clientKey>:next:<previous id>`) instead of replaying it. Still
     * idempotent: the same request lands on the same next activity.
     */
    continueAfterCompleted: z.boolean().optional(),
  })
  .strict();

/** What the next teaching unit for a skill should do, chosen by rules before compilation. */
export const learningActivityKindSchema = z.enum([
  "diagnose",
  "targeted_explain",
  "reduced_help_practice",
  "transfer_check",
  "full_explain",
]);

/**
 * Server-built learner context for one activity, stored as `goalJson.learnerFocus`.
 * Built from the learner snapshot only; a client-supplied value is never trusted.
 * The compiler receives these fields, not the learner's whole history.
 */
export const teachingLearnerFocusSchema = z
  .object({
    skillLabel: z.string().min(1).max(200),
    requirementKey: z.string().max(200).nullable().optional(),
    activityKind: learningActivityKindSchema,
    reasonCode: z.string().min(1).max(40),
    /** The verified-incorrect attempt to explain against; null when there is none. */
    focusObservationId: uuidSchema.nullable(),
    /** Assistance on the latest observations, newest first. */
    recentAssistance: z.array(assistanceLevelSchema).max(3),
    /** Historical feedback, not a diagnosis or proof of mastery. */
    recentErrors: z.array(z.object({ observationId: uuidSchema, label: z.string().min(1).max(200),
      feedback: z.string().max(1000), source: z.enum(["ai_feedback", "verified_steps"]) }).strict()).max(3).optional(),
    strategyVersion: z.string().min(1).max(40),
    goalContext: goalLearningContextSchema.optional(),
    prerequisiteRepair: prerequisiteRepairSchema.optional(),
  })
  .strict();

export const teachingActivitySchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    ownerUserId: uuidSchema,
    courseId: uuidSchema.nullable(),
    status: teachingActivityStatusSchema,
    generateStatus: teachingActivityGenerateStatusSchema,
    intentKind: teachingActivityIntentKindSchema,
    intentSummary: z.string().min(1).max(2000),
    sourceIds: z.array(uuidSchema).max(32),
    pathVersion: z.number().int().positive(),
    contentVersion: z.number().int().nonnegative(),
    checkpointJson: z.record(z.string(), z.unknown()).optional(),
    /** Read-only, server-derived focus used to keep subsequent answers on the selected skill. */
    learnerFocus: teachingLearnerFocusSchema.optional(),
    clientKey: z.string().min(8).max(200),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const teachingActivityAssociateCourseInputSchema = z.union([z
  .object({
    courseId: uuidSchema.nullable(),
    expectedUpdatedAt: isoDateTimeSchema.optional(),
  })
  .strict(), z.object({ auto: z.literal(true) }).strict()]);

/**
 * Sketch for v2 observation adapters (formal writes still go through observation services).
 * activityId required; courseId optional and must match association rules when set.
 */
export const activityObservationInputSketchSchema = z
  .object({
    activityId: uuidSchema,
    sessionId: uuidSchema,
    courseId: uuidSchema.nullable().optional(),
  })
  .strict();

export type TeachingActivityIntentKind = z.infer<typeof teachingActivityIntentKindSchema>;
export type TeachingActivityStatus = z.infer<typeof teachingActivityStatusSchema>;
export type TeachingActivityGenerateStatus = z.infer<typeof teachingActivityGenerateStatusSchema>;
export type TeachingActivityCreateInput = z.infer<typeof teachingActivityCreateInputSchema>;
export type TeachingActivity = z.infer<typeof teachingActivitySchema>;
export type LearningActivityKind = z.infer<typeof learningActivityKindSchema>;
export type TeachingLearnerFocus = z.infer<typeof teachingLearnerFocusSchema>;

/** Public question controls contain no correct answer or scoring authority. */
export const teachingQuestionInteractionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choice"), options: z.array(z.object({ id: z.string().min(1).max(20), label: z.string().min(1).max(500) }).strict()).min(2).max(6)
    .refine(options => new Set(options.map(option => option.id)).size === options.length, "选项编号不能重复") }).strict(),
  z.object({ kind: z.literal("numeric"), unit: z.string().max(40).optional() }).strict(),
]);
export type TeachingQuestionInteraction = z.infer<typeof teachingQuestionInteractionSchema>;
export const teachingVectorDiagramSchema = z.object({
  v: z.tuple([z.number().finite().min(-100).max(100), z.number().finite().min(-100).max(100)]),
  w: z.tuple([z.number().finite().min(-100).max(100), z.number().finite().min(-100).max(100)]),
}).strict();
export type TeachingVectorDiagram = z.infer<typeof teachingVectorDiagramSchema>;
export type TeachingActivityAssociateCourseInput = z.infer<
  typeof teachingActivityAssociateCourseInputSchema
>;
