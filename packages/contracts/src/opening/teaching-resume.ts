import { z } from "zod";
import { helpExposureKindSchema, assistanceLevelSchema } from "./learning";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import {
  teachingActivityGenerateStatusSchema,
  teachingActivityStatusSchema,
} from "./teaching-activity";
import {
  activitySpecClientInitSchema,
  teachingDraftAnchorSchema,
} from "./teaching-content";
import {
  TEACHING_COMMAND_LOG_MAX,
  teachingBranchFrameSchema,
  teachingCommandLogEntrySchema,
} from "./teaching-commands";

export const teachingResumeJobGateSchema = z.enum([
  "ready",
  "in_flight",
  "unknown",
  "stale",
]);
export type TeachingResumeJobGate = z.infer<typeof teachingResumeJobGateSchema>;

export const teachingResumeMaterialsGateSchema = z.enum([
  "available",
  "partial",
  "unavailable",
]);
export type TeachingResumeMaterialsGate = z.infer<
  typeof teachingResumeMaterialsGateSchema
>;

export const teachingContinuableActionSchema = z.enum([
  "continue_block",
  "edit_draft",
  "command_why",
  "command_rephrase",
  "command_expand",
  "command_example",
  "command_skip",
  "command_branch",
  "command_return",
  "wait_job",
  "resolve_material",
]);
export type TeachingContinuableAction = z.infer<
  typeof teachingContinuableActionSchema
>;

export const learningResumeAttemptOutcomeSchema = z.enum([
  "correct",
  "incorrect",
  "unverified",
  "in_progress",
]);

export const learningResumeAttemptSummarySchema = z
  .object({
    attemptId: uuidSchema,
    problemId: uuidSchema.nullable(),
    itemVersionId: uuidSchema.nullable(),
    outcome: learningResumeAttemptOutcomeSchema.nullable(),
    assistance: assistanceLevelSchema.optional(),
    submittedAt: isoDateTimeSchema.optional().nullable(),
  })
  .strict();
export type LearningResumeAttemptSummary = z.infer<
  typeof learningResumeAttemptSummarySchema
>;

export const learningResumeHelpSummarySchema = z
  .object({
    id: uuidSchema,
    kind: helpExposureKindSchema,
    level: z.enum(["hinted", "revealed"]),
    problemId: uuidSchema.nullable(),
    deliveredAt: isoDateTimeSchema.optional().nullable(),
  })
  .strict();
export type LearningResumeHelpSummary = z.infer<
  typeof learningResumeHelpSummarySchema
>;

export const learningResumeOpenProblemReasonSchema = z.enum([
  "attempt_open",
  "incorrect_unresolved",
  "unverified_unresolved",
  "checkpoint_listed",
]);

export const learningResumeOpenProblemSchema = z
  .object({
    problemId: uuidSchema,
    itemVersionId: uuidSchema.nullable(),
    reason: learningResumeOpenProblemReasonSchema,
  })
  .strict();
export type LearningResumeOpenProblem = z.infer<
  typeof learningResumeOpenProblemSchema
>;

export const teachingResumeThoughtTrainSchema = z
  .object({
    currentBlockId: uuidSchema.nullable(),
    skippedBlockIds: z.array(uuidSchema).max(500),
    branchStack: z.array(teachingBranchFrameSchema).max(16),
    commandLog: z.array(teachingCommandLogEntrySchema).max(TEACHING_COMMAND_LOG_MAX),
  })
  .strict();
export type TeachingResumeThoughtTrain = z.infer<
  typeof teachingResumeThoughtTrainSchema
>;

export const teachingResumeGatesSchema = z
  .object({
    permission: z.literal("owned"),
    materials: teachingResumeMaterialsGateSchema,
    unavailableSourceIds: z.array(uuidSchema).max(32),
    job: teachingResumeJobGateSchema,
  })
  .strict();

export const teachingResumeSummarySchema = z
  .object({
    status: z.enum(["skipped", "failed", "ready"]),
    text: z.string().max(8000).optional(),
  })
  .strict();

/**
 * Server-assembled teaching activity resume package (V2-14).
 * Distinct from ConversationResume (chat window only).
 * clientInit is null when no ActivitySpec is published yet (e.g. mid-generate).
 */
export const learningResumeSchema = z
  .object({
    activityId: uuidSchema,
    status: teachingActivityStatusSchema,
    generateStatus: teachingActivityGenerateStatusSchema,
    contentVersion: z.number().int().nonnegative(),
    pathVersion: z.number().int().positive(),
    clientInit: activitySpecClientInitSchema.nullable(),
    thoughtTrain: teachingResumeThoughtTrainSchema,
    drafts: z.array(teachingDraftAnchorSchema).max(64),
    interactionParams: z
      .record(uuidSchema, z.record(z.string(), z.unknown()))
      .default({}),
    actualAttempts: z.array(learningResumeAttemptSummarySchema).max(100),
    helpDelivered: z.array(learningResumeHelpSummarySchema).max(100),
    openProblems: z.array(learningResumeOpenProblemSchema).max(100),
    gates: teachingResumeGatesSchema,
    continuableActions: z.array(teachingContinuableActionSchema).max(32),
    summary: teachingResumeSummarySchema.optional(),
  })
  .strict();
export type LearningResume = z.infer<typeof learningResumeSchema>;

export const teachingCheckpointSaveInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    drafts: z.array(teachingDraftAnchorSchema).max(64).optional(),
    currentBlockId: uuidSchema.nullable().optional(),
    interactionParams: z
      .record(uuidSchema, z.record(z.string(), z.unknown()))
      .optional(),
    openProblemIds: z.array(uuidSchema).max(64).optional(),
  })
  .strict();
export type TeachingCheckpointSaveInput = z.infer<
  typeof teachingCheckpointSaveInputSchema
>;

export const teachingCheckpointSaveResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      contentVersion: z.number().int().nonnegative(),
      checkpointJson: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      mismatch: z.literal("draft_anchor_lost"),
      lostBlockIds: z.array(uuidSchema).min(1),
    })
    .strict(),
]);
export type TeachingCheckpointSaveResult = z.infer<
  typeof teachingCheckpointSaveResultSchema
>;

/** Completing an activity records the end of a session, not mastery. */
export const teachingActivityStatusUpdateInputSchema = z
  .object({
    status: z.enum(["active", "paused", "completed"]),
    expectedUpdatedAt: isoDateTimeSchema.optional(),
  })
  .strict();
export type TeachingActivityStatusUpdateInput = z.infer<
  typeof teachingActivityStatusUpdateInputSchema
>;

export const teachingActivitySummarySchema = z.object({
  coveredBlockIds: z.array(uuidSchema).max(500),
  skippedBlockIds: z.array(uuidSchema).max(500),
  attempts: z.object({
    total: z.number().int().nonnegative(),
    correct: z.number().int().nonnegative(),
    incorrect: z.number().int().nonnegative(),
    unverified: z.number().int().nonnegative(),
  }).strict(),
  openQuestions: z.array(z.string().max(2000)),
  taskId: uuidSchema.nullable(),
}).strict();
export type TeachingActivitySummary = z.infer<typeof teachingActivitySummarySchema>;

export const teachingAnswerKeySchema = z.object({
  answer: z.string().max(20_000).nullable(),
  referenceSourceId: uuidSchema.nullable(),
}).strict();
export type TeachingAnswerKey = z.infer<typeof teachingAnswerKeySchema>;
