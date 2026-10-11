import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

export const teachingBlockRoleSchema = z.enum([
  "teach",
  "prompt",
  "example",
  "answer_key",
  "meta",
]);

export const teachingVerificationStatusSchema = z.enum([
  "unchecked",
  "structure_ok",
  "needs_check",
  "verified",
  "rejected",
  "stale",
]);

export const teachingGoalSchema = z
  .object({
    goalId: z.string().min(1).max(200),
    statement: z.string().min(1).max(2000),
    successCriteria: z.array(z.string().min(1).max(500)).max(32).optional(),
    linkedSourceIds: z.array(uuidSchema).max(32).optional(),
  })
  .strict();

export const teachingBlockRefSchema = z
  .object({
    blockId: uuidSchema,
    position: z.number().int().nonnegative(),
    blockType: z.string().min(1).max(120),
    role: teachingBlockRoleSchema,
  })
  .strict();

export const teachingSourceRefSchema = z
  .object({
    sourceId: uuidSchema,
    version: z.union([z.string(), z.number()]).nullable().optional(),
    chunkId: z.string().min(1).max(200).nullable().optional(),
    page: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const teachingGenerationConfigSchema = z
  .object({
    providerHint: z.string().min(1).max(120).optional(),
    budgetClass: z.string().min(1).max(120).optional(),
    locale: z.string().min(1).max(32).optional(),
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const teachingUnitSchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    ownerUserId: uuidSchema,
    title: z.string().min(1).max(500),
    documentId: uuidSchema,
    currentRevisionNumber: z.number().int().nonnegative(),
    goals: z.array(teachingGoalSchema).max(64),
    verificationStatus: teachingVerificationStatusSchema,
    generationConfig: teachingGenerationConfigSchema,
    version: z.number().int().nonnegative(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const teachingUnitCreateInputSchema = z
  .object({
    title: z.string().min(1).max(500),
    goals: z.array(teachingGoalSchema).max(64).optional(),
    verificationStatus: teachingVerificationStatusSchema.optional(),
    generationConfig: teachingGenerationConfigSchema.optional(),
    /** Library lifecycle for the sole body document. Default candidate. */
    lifecycle: z.enum(["scratch", "candidate"]).optional(),
    blocks: z
      .array(
        z
          .object({
            id: uuidSchema,
            type: z.string().min(1).max(120),
            content: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .max(500)
      .optional(),
  })
  .strict();

export const activitySpecSchema = z
  .object({
    id: uuidSchema,
    activityId: uuidSchema,
    teachingUnitId: uuidSchema,
    documentId: uuidSchema,
    revisionNumber: z.number().int().positive(),
    blockOrder: z.array(teachingBlockRefSchema).max(500),
    sourceRefs: z.array(teachingSourceRefSchema).max(64),
    goals: z.array(teachingGoalSchema).max(64),
    verificationStatus: teachingVerificationStatusSchema,
    generationConfig: teachingGenerationConfigSchema,
    /** Mirrors activity.contentVersion after a successful publish. */
    version: z.number().int().nonnegative(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

/**
 * Soft-idempotent publish graph (knowledge pattern): compared when the activity
 * is already at expectedVersion+1. Equality set =
 * teachingUnitId, documentId, revisionNumber, blockOrder, sourceRefs, goals,
 * verificationStatus, generationConfig.
 */
export const activitySpecPublishInputSchema = z
  .object({
    activityId: uuidSchema,
    teachingUnitId: uuidSchema,
    expectedVersion: z.number().int().nonnegative(),
    /** When also writing library body in the same product call; metadata-only publish may omit. */
    expectedRevisionNumber: z.number().int().positive().optional(),
    revisionNumber: z.number().int().positive(),
    blockOrder: z.array(teachingBlockRefSchema).max(500),
    sourceRefs: z.array(teachingSourceRefSchema).max(64).optional(),
    goals: z.array(teachingGoalSchema).max(64).optional(),
    verificationStatus: teachingVerificationStatusSchema.optional(),
    generationConfig: teachingGenerationConfigSchema.optional(),
  })
  .strict();

export const teachingAnswerRefSchema = z
  .object({
    refId: uuidSchema,
    revealState: z.enum(["hidden", "revealed"]),
  })
  .strict();

export const activitySpecClientBlockSchema = z
  .object({
    blockId: uuidSchema,
    position: z.number().int().nonnegative(),
    blockType: z.string().min(1).max(120),
    role: teachingBlockRoleSchema,
    /** Null when role=answer_key and revealState=hidden. */
    content: z.unknown().nullable(),
    answerRef: teachingAnswerRefSchema.optional(),
  })
  .strict()
  .superRefine((block, ctx) => {
    if (
      block.role === "answer_key" &&
      block.answerRef?.revealState === "hidden" &&
      block.content != null
    ) {
      ctx.addIssue({
        code: "custom",
        message: "answer_key plaintext forbidden when revealState is hidden",
      });
    }
  });

/** Client-safe projection — never carries unrevealed answer_key plaintext. */
export const activitySpecClientInitSchema = activitySpecSchema
  .extend({
    blocks: z.array(activitySpecClientBlockSchema).max(500),
    contentVersion: z.number().int().nonnegative(),
    checkpointJson: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const teachingDraftAnchorSchema = z
  .object({
    blockId: uuidSchema,
    contentVersion: z.number().int().nonnegative(),
    draftText: z.string().max(8000).optional(),
    draftDocumentId: uuidSchema.optional(),
  })
  .strict();

export const teachingDraftAnchorsSaveInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    drafts: z.array(teachingDraftAnchorSchema).max(64),
  })
  .strict();

export const teachingDraftAnchorsSaveResultSchema = z.discriminatedUnion("ok", [
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

/**
 * M1 `getActivitySpecAtVersion` semantics (no ActivitySpec history table):
 * - Only the current `opening_teaching_activity_specs` row is retained.
 * - When `version` equals that row's `version`, the full ActivitySpec is returned.
 * - Older versions are not reconstructable from ActivitySpec metadata
 *   (past blockOrder / goals / sourceRefs are unavailable).
 * - Past teaching **body** remains readable via library `readRevision(documentId, revisionNumber)`
 *   using the pinned revision_number stored on the current row (or any earlier library revision
 *   the caller already knows). There is no past-spec list API in M1.
 */
export const activitySpecAtVersionM1Note =
  "M1: current ActivitySpec row only; historical body via library revision_number; no past-spec list" as const;

export type TeachingBlockRole = z.infer<typeof teachingBlockRoleSchema>;
export type TeachingVerificationStatus = z.infer<typeof teachingVerificationStatusSchema>;
export type TeachingGoal = z.infer<typeof teachingGoalSchema>;
export type TeachingBlockRef = z.infer<typeof teachingBlockRefSchema>;
export type TeachingSourceRef = z.infer<typeof teachingSourceRefSchema>;
export type TeachingGenerationConfig = z.infer<typeof teachingGenerationConfigSchema>;
export type TeachingUnit = z.infer<typeof teachingUnitSchema>;
export type TeachingUnitCreateInput = z.infer<typeof teachingUnitCreateInputSchema>;
export type ActivitySpec = z.infer<typeof activitySpecSchema>;
export type ActivitySpecPublishInput = z.infer<typeof activitySpecPublishInputSchema>;
export type ActivitySpecClientInit = z.infer<typeof activitySpecClientInitSchema>;
export type TeachingDraftAnchor = z.infer<typeof teachingDraftAnchorSchema>;
export type TeachingDraftAnchorsSaveInput = z.infer<typeof teachingDraftAnchorsSaveInputSchema>;
export type TeachingDraftAnchorsSaveResult = z.infer<typeof teachingDraftAnchorsSaveResultSchema>;
