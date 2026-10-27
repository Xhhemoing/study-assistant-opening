import { z } from "zod";
import { calendarDateSchema, isoDateTimeSchema, uuidSchema } from "./foundation";
import { planDraftSchema, plannedBlockSchema } from "./planning";
import { taskItemSchema } from "./planning-tasks";
import { learningGoalSchema } from "./learning-goals";

export const learningManagementSettingsSchema = z.object({ dailyMinutes: z.number().int().min(1).max(600), bufferMinutes: z.number().int().min(0).max(120), revision: z.number().int().positive(), updatedAt: isoDateTimeSchema }).strict().refine(value => value.bufferMinutes < value.dailyMinutes, "Buffer must be smaller than daily budget");
export const learningActivityBudgetSchema = z.object({ localDate: calendarDateSchema, timeZone: z.string().min(1).max(80), minutes: z.number().finite().positive().max(1440),
  budgetRevision: z.number().int().positive().optional(), goalId: uuidSchema.optional(), goalIds: z.array(uuidSchema).max(200).optional(), goalRevision: z.number().int().positive().optional() }).strict();
export const learningManagementCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("settings"), dailyMinutes: z.number().int().min(1).max(600), bufferMinutes: z.number().int().min(0).max(120), expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("preview"), date: calendarDateSchema, expectedAcceptedVersion: z.number().int().nonnegative(), expectedBudgetRevision: z.number().int().positive(), clientKey: z.string().min(8).max(200) }).strict(),
  z.object({ action: z.literal("confirm"), draftId: uuidSchema, expectedBaseVersion: z.number().int().nonnegative(), clientKey: z.string().min(8).max(200) }).strict(),
]);
export const learningRecoveryCommandSchema = z.object({ action: z.enum(["continue", "shorten", "replan"]), activityId: uuidSchema.nullable(), taskId: uuidSchema.nullable(), minutes: z.number().int().min(5).max(240).optional(), date: calendarDateSchema, expectedAcceptedVersion: z.number().int().nonnegative(), expectedBudgetRevision: z.number().int().nonnegative(), clientKey: z.string().min(8).max(200) }).strict();
export const learningLifecycleCommandSchema = z.object({ goalId: uuidSchema, expectedRevision: z.number().int().nonnegative(), lifecycle: z.enum(["active", "maintenance", "reduced", "paused", "archived", "stopped"]), maintenanceIntervalDays: z.number().int().min(1).max(365).nullable().optional(), acceptedPolicy: z.literal("keep") }).strict();
export const learningCardSessionCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), budgetMinutes: z.number().int().min(1).max(120), cardIds: z.array(uuidSchema).min(1).max(200), goalIds: z.array(uuidSchema).max(40).default([]), clientKey: z.string().min(8).max(200) }).strict(),
  z.object({ action: z.literal("stop"), activityId: uuidSchema, expectedRevision: z.number().int().positive(), elapsedSeconds: z.number().int().min(0).max(43200), reviewedCardIds: z.array(uuidSchema).max(200), reason: z.enum(["time_used", "finished", "pause"]) }).strict(),
]);
export const learningCardSessionSchema = z.object({ activityId: uuidSchema, status: z.enum(["active", "paused", "completed"]), revision: z.number().int().positive(), cardIds: z.array(uuidSchema), reviewedCardIds: z.array(uuidSchema), budgetMinutes: z.number().int().positive(), elapsedSeconds: z.number().int().nonnegative(), startedAt: isoDateTimeSchema, stoppedAt: isoDateTimeSchema.nullable(), href: z.string() }).strict();
export const learningManagementOverviewSchema = z.object({
  date: calendarDateSchema, timeZone: z.string(), budget: learningManagementSettingsSchema.nullable(), acceptedVersion: z.number().int().nonnegative(),
  acceptedBlocks: z.array(plannedBlockSchema), committedMinutes: z.number().nonnegative(), remainingMinutes: z.number().nonnegative(), overcommittedMinutes: z.number().nonnegative(),
  tasks: z.array(taskItemSchema), recovery: z.object({ kind: z.enum(["continue", "replan", "none"]), activityId: uuidSchema.nullable(), taskId: uuidSchema.nullable(), href: z.string().nullable() }).strict(),
  warnings: z.array(z.string()), cardSessions: z.array(learningCardSessionSchema),
  maintenanceTasks: z.array(z.object({ taskId: uuidSchema, goalId: uuidSchema, requirementId: uuidSchema, version: z.number().int().positive() }).strict()).default([]),
}).strict();
export const learningMaintenanceStartSchema = z.object({ taskId: uuidSchema, expectedVersion: z.number().int().positive(), clientKey: z.string().min(8).max(200) }).strict();
export const learningManagementResultSchema = z.object({ overview: learningManagementOverviewSchema, draft: planDraftSchema.nullable() }).strict();
export const learningRecoveryResultSchema = z.union([learningManagementResultSchema, z.object({ href: z.string(), activityId: uuidSchema.nullable(), taskId: uuidSchema.nullable() }).strict()]);
export const learningLifecycleResultSchema = z.object({ goal: learningGoalSchema, acceptedPolicy: z.literal("keep"), message: z.string() }).strict();
export const learningManagementDraftMetadataSchema = z.object({ budgetRevision: z.number().int().positive(), localDate: calendarDateSchema,
  goalRevisions: z.array(z.object({ goalId: uuidSchema, revision: z.number().int().positive() }).strict()).max(200),
}).strict();
export type LearningManagementSettings = z.infer<typeof learningManagementSettingsSchema>;
export type LearningManagementOverview = z.infer<typeof learningManagementOverviewSchema>;
export type LearningCardSession = z.infer<typeof learningCardSessionSchema>;
