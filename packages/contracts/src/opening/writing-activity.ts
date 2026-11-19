import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { assistanceLevelSchema } from "./learning";

export const WRITING_WORKSPACE_PROTOCOL = "writing-workspace-v1" as const;
export const WRITING_META_PROPERTY_KEY = "opening.writing.meta" as const;

export const writingDimensionSchema = z.enum([
  "argument",
  "language",
  "structure",
  "evidence",
]);
export const writingAssistanceKindSchema = z.enum([
  "feedback",
  "polish_suggestion",
]);

export const writingAssistanceRecordSchema = z
  .object({
    id: uuidSchema,
    documentId: uuidSchema,
    baseRevisionNumber: z.number().int().nonnegative(),
    targetBlockId: z.string().min(1).max(120).nullable(),
    targetBlockTextSnapshot: z.string().max(4000),
    dimension: writingDimensionSchema,
    kind: writingAssistanceKindSchema,
    suggestionText: z.string().min(1).max(4000),
    adoptedAt: isoDateTimeSchema.nullable(),
    adoptedRevisionNumber: z.number().int().nonnegative().nullable(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const writingVariantMetaSchema = z
  .object({
    workGroupId: uuidSchema,
    variantLabel: z.string().trim().min(1).max(80),
    parentDocumentId: uuidSchema.nullable(),
    parentRevisionNumber: z.number().int().nonnegative().nullable(),
    keptAsPreferred: z.boolean(),
    focusBlockId: z.string().min(1).max(120).nullable(),
    assistanceRecords: z.array(writingAssistanceRecordSchema).max(100),
  })
  .strict();

export const writingActivityCheckpointSchema = z
  .object({
    protocol: z.literal(WRITING_WORKSPACE_PROTOCOL),
    workGroupId: uuidSchema,
    activeDocumentId: uuidSchema,
    activeVariantLabel: z.string().trim().min(1).max(80),
    savedRevisionNumber: z.number().int().nonnegative(),
    focusBlockId: z.string().min(1).max(120).nullable(),
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const writingFocusRestoreSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }).strict(),
  z
    .object({
      status: z.literal("exact"),
      blockId: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      status: z.literal("block_missing"),
      requestedBlockId: z.string().min(1).max(120),
      message: z.string().min(1).max(300),
    })
    .strict(),
]);

export const writingVariantSummarySchema = z
  .object({
    documentId: uuidSchema,
    title: z.string().min(1).max(500),
    variantLabel: z.string().min(1).max(80),
    currentRevisionNumber: z.number().int().nonnegative(),
    parentDocumentId: uuidSchema.nullable(),
    parentRevisionNumber: z.number().int().nonnegative().nullable(),
    keptAsPreferred: z.boolean(),
    focusBlockId: z.string().min(1).max(120).nullable(),
    assistanceCount: z.number().int().nonnegative(),
    adoptedPolishCount: z.number().int().nonnegative(),
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const writingStartInputSchema = z
  .object({
    clientKey: z.string().min(8).max(200),
    title: z.string().trim().min(1).max(300),
    initialText: z.string().max(20_000).optional(),
    variantLabel: z.string().trim().min(1).max(80).optional(),
    courseId: uuidSchema.nullable().optional(),
  })
  .strict();

export const writingCommandInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("derive_variant"),
      expectedRevisionNumber: z.number().int().nonnegative(),
      variantLabel: z.string().trim().min(1).max(80),
      focusBlockId: z.string().min(1).max(120).nullable().optional(),
      activityId: uuidSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("record_feedback"),
      expectedRevisionNumber: z.number().int().nonnegative(),
      targetBlockId: z.string().min(1).max(120).nullable(),
      dimension: writingDimensionSchema,
      kind: writingAssistanceKindSchema,
      suggestionText: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      action: z.literal("adopt_suggestion"),
      expectedRevisionNumber: z.number().int().nonnegative(),
      assistanceId: uuidSchema,
      targetBlockId: z.string().min(1).max(120),
      replacementText: z.string().trim().min(1).max(20_000),
      activityId: uuidSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("save_checkpoint"),
      activityId: uuidSchema.optional(),
      focusBlockId: z.string().min(1).max(120).nullable(),
      keptAsPreferred: z.boolean().optional(),
    })
    .strict(),
]);

export const writingWorkspaceViewSchema = z
  .object({
    workGroupId: uuidSchema,
    activityId: uuidSchema.nullable(),
    courseId: uuidSchema.nullable(),
    currentDocumentId: uuidSchema,
    currentVariant: writingVariantMetaSchema,
    variants: z.array(writingVariantSummarySchema).min(1).max(50),
    focusRestore: writingFocusRestoreSchema,
  })
  .strict();

export const writingWorkspaceResponseSchema = z.discriminatedUnion("initialized", [
  z
    .object({
      initialized: z.literal(false),
      documentId: uuidSchema,
    })
    .strict(),
  z
    .object({
      initialized: z.literal(true),
      workspace: writingWorkspaceViewSchema,
    })
    .strict(),
]);

export const courselessActivityOutcomeSchema = z
  .object({
    activityId: uuidSchema,
    courseId: uuidSchema.nullable(),
    documentId: uuidSchema,
    revisionNumber: z.number().int().positive(),
    assistance: assistanceLevelSchema,
    adoptedPolishCount: z.number().int().nonnegative(),
    keptAsPreferred: z.boolean(),
    evidenceVerdict: z.literal("MASTERY_NOT_ESTABLISHED"),
  })
  .strict();

export type WritingDimension = z.infer<typeof writingDimensionSchema>;
export type WritingAssistanceKind = z.infer<typeof writingAssistanceKindSchema>;
export type WritingAssistanceRecord = z.infer<typeof writingAssistanceRecordSchema>;
export type WritingVariantMeta = z.infer<typeof writingVariantMetaSchema>;
export type WritingActivityCheckpoint = z.infer<typeof writingActivityCheckpointSchema>;
export type WritingFocusRestore = z.infer<typeof writingFocusRestoreSchema>;
export type WritingVariantSummary = z.infer<typeof writingVariantSummarySchema>;
export type WritingStartInput = z.infer<typeof writingStartInputSchema>;
export type WritingCommandInput = z.infer<typeof writingCommandInputSchema>;
export type WritingWorkspaceView = z.infer<typeof writingWorkspaceViewSchema>;
export type WritingWorkspaceResponse = z.infer<typeof writingWorkspaceResponseSchema>;
export type CourselessActivityOutcome = z.infer<typeof courselessActivityOutcomeSchema>;
