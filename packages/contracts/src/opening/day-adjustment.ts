import { z } from "zod";
import {
  calendarDateSchema,
  DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX,
  DAY_ADJUSTMENT_RESERVED_PROPOSE_KEY_RE,
  DAY_EXCEPTION_PROPOSE_KEY_PREFIX,
  DAY_EXCEPTION_RESERVED_PROPOSE_KEY_RE,
  isReservedDayAdjustmentProposeKey,
  isReservedDayAdjustmentProposePrefix,
  isReservedDayExceptionProposeKey,
  isoDateTimeSchema,
  sha256HexSchema,
  uuidSchema,
} from "./foundation";
import { plannedBlockSchema, timeBlockSchema } from "./planning";

export const DAY_EXCEPTION_STRATEGY_VERSION = "day-exception-v1" as const;
export const DAY_ADJUSTMENT_STRATEGY_VERSION = "day-adjustment-v1" as const;
export const DAY_EXCEPTION_SNAPSHOT_KIND = "day_exception_v1" as const;
export const DAY_ADJUSTMENT_SNAPSHOT_KIND = "day_adjustment_v1" as const;
export {
  DAY_EXCEPTION_PROPOSE_KEY_PREFIX,
  DAY_ADJUSTMENT_PROPOSE_KEY_PREFIX,
  DAY_EXCEPTION_RESERVED_PROPOSE_KEY_RE,
  DAY_ADJUSTMENT_RESERVED_PROPOSE_KEY_RE,
  isReservedDayAdjustmentProposePrefix,
  isReservedDayExceptionProposeKey,
  isReservedDayAdjustmentProposeKey,
};

export const dayAdjustmentTimeZoneSchema = z.string().trim().min(1).max(80);
export const dayAdjustmentClientKeySchema = z.string().min(8).max(200);

/** Stored inside opening_plan_drafts.input_snapshot.dayException for Tx1. */
export const dayExceptionSnapshotSchema = z
  .object({
    kind: z.literal(DAY_EXCEPTION_SNAPSHOT_KIND),
    clientKey: uuidSchema,
    localDate: calendarDateSchema,
    timeZone: dayAdjustmentTimeZoneSchema,
    effectiveAt: isoDateTimeSchema,
    remainingMinutes: z.number().int().min(1).max(600),
    expectedExceptionRevision: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
  })
  .strict();

export type DayExceptionSnapshot = z.infer<typeof dayExceptionSnapshotSchema>;

export const dayExceptionDeclareInputSchema = z
  .object({
    clientKey: uuidSchema,
    localDate: calendarDateSchema,
    expectedTimeZone: dayAdjustmentTimeZoneSchema,
    expectedExceptionRevision: z.number().int().nonnegative(),
    remainingMinutes: z.number().int().min(1).max(600),
  })
  .strict();

export type DayExceptionDeclareInput = z.infer<typeof dayExceptionDeclareInputSchema>;

export const dayExceptionReceiptSchema = z
  .object({
    id: uuidSchema,
    localDate: calendarDateSchema,
    timeZone: dayAdjustmentTimeZoneSchema,
    effectiveAt: isoDateTimeSchema,
    remainingMinutes: z.number().int().min(1).max(600),
    expectedExceptionRevision: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    replayed: z.boolean(),
  })
  .strict();

export type DayExceptionReceipt = z.infer<typeof dayExceptionReceiptSchema>;

export const dayAdjustmentTaskRevisionSchema = z
  .object({
    taskId: uuidSchema,
    version: z.number().int().positive(),
  })
  .strict();

export type DayAdjustmentTaskRevision = z.infer<typeof dayAdjustmentTaskRevisionSchema>;

export const dayAdjustmentRetestRevisionSchema = z
  .object({
    retestId: uuidSchema,
    taskId: uuidSchema,
    version: z.number().int().positive(),
    scheduledStartAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export type DayAdjustmentRetestRevision = z.infer<typeof dayAdjustmentRetestRevisionSchema>;

export const dayAdjustmentTargetPlacementSchema = z
  .object({
    taskId: uuidSchema,
    start: isoDateTimeSchema,
  })
  .strict();

export type DayAdjustmentTargetPlacement = z.infer<typeof dayAdjustmentTargetPlacementSchema>;

export const dayAdjustmentPreviewInputSchema = z
  .object({
    date: calendarDateSchema.optional(),
    targetDate: calendarDateSchema.nullable().optional(),
    moveTaskIds: z.array(uuidSchema).max(50).optional(),
    removeTaskIds: z.array(uuidSchema).max(50).optional(),
    quickTaskId: uuidSchema.nullable().optional(),
    quickStartAt: isoDateTimeSchema.optional(),
    targetStartAt: isoDateTimeSchema.optional(),
    targetPlacements: z.array(dayAdjustmentTargetPlacementSchema).max(50).optional(),
  })
  .strict();

export type DayAdjustmentPreviewInput = z.infer<typeof dayAdjustmentPreviewInputSchema>;

export const dayAdjustmentCapacitySummarySchema = z
  .object({
    dailyMinutes: z.number().int().positive().nullable(),
    bufferMinutes: z.number().int().nonnegative().nullable(),
    dayUsedMinutes: z.number().nonnegative(),
    exceptionRemainingMinutes: z.number().int().positive().nullable(),
    afterLowerMinutes: z.number().nonnegative(),
    afterUpperMinutes: z.number().nonnegative(),
    availableLowerMinutes: z.number().nonnegative(),
    availableUpperMinutes: z.number().nonnegative(),
    requiredMinutes: z.number().nonnegative(),
    shortfallMinutes: z.number().nonnegative(),
    usageUncertain: z.boolean(),
  })
  .strict();

export type DayAdjustmentCapacitySummary = z.infer<typeof dayAdjustmentCapacitySummarySchema>;

export const dayAdjustmentQuickCandidateSchema = z
  .object({
    taskId: uuidSchema,
    title: z.string().min(1).max(240),
    minutes: z.number().int().positive().max(240),
    version: z.number().int().positive(),
    fits: z.boolean(),
    shortfallMinutes: z.number().nonnegative(),
    reason: z.string().min(1).max(300),
    suggestedSlot: timeBlockSchema.nullable(),
  })
  .strict();

export type DayAdjustmentQuickCandidate = z.infer<typeof dayAdjustmentQuickCandidateSchema>;

export const dayAdjustmentTaskSummarySchema = z
  .object({
    taskId: uuidSchema,
    title: z.string().min(1).max(240),
    minutes: z.number().int().positive().max(240),
    version: z.number().int().positive(),
    isRetest: z.boolean(),
    retestId: uuidSchema.nullable(),
    retestVersion: z.number().int().positive().nullable(),
    retestScheduledStartAt: isoDateTimeSchema.nullable(),
    dueAt: isoDateTimeSchema.nullable(),
    notBefore: isoDateTimeSchema.nullable(),
  })
  .strict();

export type DayAdjustmentTaskSummary = z.infer<typeof dayAdjustmentTaskSummarySchema>;

export const dayAdjustmentSourceActionsSchema = z
  .object({
    keptBlocks: z.array(plannedBlockSchema).max(200),
    removedBlocks: z.array(plannedBlockSchema).max(200),
    addedBlocks: z.array(plannedBlockSchema).max(200),
  })
  .strict();

export type DayAdjustmentSourceActions = z.infer<typeof dayAdjustmentSourceActionsSchema>;

export const dayAdjustmentTargetActionsSchema = z
  .object({
    targetDate: calendarDateSchema,
    addedBlocks: z.array(plannedBlockSchema).max(200),
  })
  .strict();

export type DayAdjustmentTargetActions = z.infer<typeof dayAdjustmentTargetActionsSchema>;

export const dayAdjustmentPreviewStatusSchema = z.enum([
  "no_exception",
  "ready",
  "no_change",
  "usage_uncertain",
  "shortfall",
]);

export type DayAdjustmentPreviewStatus = z.infer<typeof dayAdjustmentPreviewStatusSchema>;

export const dayAdjustmentPreviewSchema = z
  .object({
    status: dayAdjustmentPreviewStatusSchema,
    sourceDate: calendarDateSchema,
    targetDate: calendarDateSchema.nullable(),
    timeZone: dayAdjustmentTimeZoneSchema,
    now: isoDateTimeSchema,
    dayException: dayExceptionReceiptSchema.nullable(),
    exceptionRevision: z.number().int().nonnegative(),
    budgetRevision: z.number().int().nonnegative().nullable(),
    sourceAcceptedVersion: z.number().int().nonnegative(),
    targetAcceptedVersion: z.number().int().nonnegative().nullable(),
    sourceBeforeBlocks: z.array(plannedBlockSchema).max(200),
    sourceAfterBlocks: z.array(plannedBlockSchema).max(200),
    targetBeforeBlocks: z.array(plannedBlockSchema).max(200),
    targetAfterBlocks: z.array(plannedBlockSchema).max(200),
    keptBlocks: z.array(plannedBlockSchema).max(200),
    removedBlocks: z.array(plannedBlockSchema).max(200),
    sourceAddedBlocks: z.array(plannedBlockSchema).max(200),
    targetAddedBlocks: z.array(plannedBlockSchema).max(200),
    sourceFreeSlots: z.array(timeBlockSchema).max(200),
    targetFreeSlots: z.array(timeBlockSchema).max(200),
    capacityBefore: dayAdjustmentCapacitySummarySchema,
    capacityAfter: dayAdjustmentCapacitySummarySchema,
    targetCapacityAfter: dayAdjustmentCapacitySummarySchema.nullable(),
    taskRevisions: z.array(dayAdjustmentTaskRevisionSchema).max(200),
    retestRevisions: z.array(dayAdjustmentRetestRevisionSchema).max(200),
    tasks: z.array(dayAdjustmentTaskSummarySchema).max(200),
    quickCandidates: z.array(dayAdjustmentQuickCandidateSchema).max(200),
    unplacedMoveTaskIds: z.array(uuidSchema).max(50),
    blockers: z.array(z.string().min(1).max(300)).max(50),
    canConfirm: z.boolean(),
  })
  .strict();

export type DayAdjustmentPreview = z.infer<typeof dayAdjustmentPreviewSchema>;

export const dayAdjustmentConfirmInputSchema = z
  .object({
    clientKey: dayAdjustmentClientKeySchema,
    sourceDate: calendarDateSchema,
    expectedTimeZone: dayAdjustmentTimeZoneSchema,
    expectedExceptionRevision: z.number().int().positive(),
    expectedBudgetRevision: z.number().int().nonnegative().nullable(),
    expectedSourceAcceptedVersion: z.number().int().nonnegative(),
    expectedTargetAcceptedVersion: z.number().int().nonnegative().nullable().optional(),
    expectedTaskRevisions: z.array(dayAdjustmentTaskRevisionSchema).max(200),
    expectedRetestRevisions: z.array(dayAdjustmentRetestRevisionSchema).max(200),
    sourceActions: dayAdjustmentSourceActionsSchema,
    targetActions: dayAdjustmentTargetActionsSchema.nullable().optional(),
  })
  .strict();

export type DayAdjustmentConfirmInput = z.infer<typeof dayAdjustmentConfirmInputSchema>;

export const dayAdjustmentDaySnapshotSchema = z
  .object({
    day: calendarDateSchema,
    beforeVersion: z.number().int().nonnegative(),
    afterVersion: z.number().int().positive(),
    beforeBlocks: z.array(plannedBlockSchema).max(200),
    afterBlocks: z.array(plannedBlockSchema).max(200),
    keptBlocks: z.array(plannedBlockSchema).max(200).optional(),
    removedBlocks: z.array(plannedBlockSchema).max(200).optional(),
    addedBlocks: z.array(plannedBlockSchema).max(200),
  })
  .strict();

export type DayAdjustmentDaySnapshot = z.infer<typeof dayAdjustmentDaySnapshotSchema>;

export const dayAdjustmentRetestRescheduleSchema = z
  .object({
    retestId: uuidSchema,
    taskId: uuidSchema,
    beforeVersion: z.number().int().positive(),
    afterVersion: z.number().int().positive(),
    beforeScheduledStartAt: isoDateTimeSchema.nullable(),
    afterScheduledStartAt: isoDateTimeSchema,
  })
  .strict();

export type DayAdjustmentRetestReschedule = z.infer<typeof dayAdjustmentRetestRescheduleSchema>;

/** Stored inside opening_plan_drafts.input_snapshot.dayAdjustment for Tx2. */
export const dayAdjustmentSnapshotSchema = z
  .object({
    kind: z.literal(DAY_ADJUSTMENT_SNAPSHOT_KIND),
    clientKey: dayAdjustmentClientKeySchema,
    payloadHash: sha256HexSchema,
    confirmedAt: isoDateTimeSchema,
    timeZone: dayAdjustmentTimeZoneSchema,
    sourceDate: calendarDateSchema,
    targetDate: calendarDateSchema.nullable(),
    exceptionDraftId: uuidSchema,
    exceptionRevision: z.number().int().positive(),
    budgetRevision: z.number().int().nonnegative().nullable(),
    sourceDay: dayAdjustmentDaySnapshotSchema,
    targetDay: dayAdjustmentDaySnapshotSchema.nullable(),
    retestReschedules: z.array(dayAdjustmentRetestRescheduleSchema).max(200),
  })
  .strict();

export type DayAdjustmentSnapshot = z.infer<typeof dayAdjustmentSnapshotSchema>;

export const dayAdjustmentConfirmReceiptSchema = z
  .object({
    draftId: uuidSchema,
    clientKey: dayAdjustmentClientKeySchema,
    timeZone: dayAdjustmentTimeZoneSchema,
    confirmedAt: isoDateTimeSchema,
    exceptionDraftId: uuidSchema,
    exceptionRevision: z.number().int().positive(),
    sourceDate: calendarDateSchema,
    sourceBeforeVersion: z.number().int().nonnegative(),
    sourceAfterVersion: z.number().int().positive(),
    sourceBlocks: z.array(plannedBlockSchema).max(200),
    targetDate: calendarDateSchema.nullable(),
    targetBeforeVersion: z.number().int().nonnegative().nullable(),
    targetAfterVersion: z.number().int().positive().nullable(),
    targetBlocks: z.array(plannedBlockSchema).max(200).nullable(),
    retestReschedules: z.array(dayAdjustmentRetestRescheduleSchema).max(200),
    replayed: z.boolean(),
  })
  .strict();

export type DayAdjustmentConfirmReceipt = z.infer<typeof dayAdjustmentConfirmReceiptSchema>;

export const dayAdjustmentPostInputSchema = z.discriminatedUnion("action", [
  dayExceptionDeclareInputSchema.extend({ action: z.literal("declare_today") }).strict(),
  dayAdjustmentPreviewInputSchema.extend({ action: z.literal("preview") }).strict(),
  dayAdjustmentConfirmInputSchema.extend({ action: z.literal("confirm") }).strict(),
]);

export type DayAdjustmentPostInput = z.infer<typeof dayAdjustmentPostInputSchema>;
