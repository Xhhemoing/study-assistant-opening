import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { suggestionKindSchema } from "./planning-tasks";

export const weekSessionSchema = z
  .object({
    courseName: z.string().min(1).max(200),
    /** Optional course binding; courseName remains the timetable display label (RU-05). */
    courseId: uuidSchema.nullable().optional(),
    weekday: z.number().int().min(1).max(7),
    weeks: z.array(z.number().int().positive()).min(1).max(60),
    startPeriod: z.number().int().positive(),
    endPeriod: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.startPeriod > value.endPeriod) {
      ctx.addIssue({
        code: "custom",
        message: "startPeriod must be <= endPeriod",
        path: ["endPeriod"],
      });
    }
  });

export const timeBlockSchema = z
  .object({
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
    kind: z.enum(["class", "sleep", "meal", "locked", "free"]),
  })
  .strict();

export {
  suggestionKindSchema,
  taskItemSchema,
  taskOriginSchema,
  taskRetestProjectionSchema,
  retestTaskSnapshotSchema,
  taskCreateInputSchema,
  taskCreateResultSchema,
  taskStatusUpdateInputSchema,
  taskDeferInputSchema,
  type TaskItem,
  type TaskOrigin,
  type TaskRetestProjection,
  type TaskCreateInput,
  type TaskCreateResult,
  type TaskStatusUpdateInput,
  type TaskDeferInput,
} from "./planning-tasks";

export const plannedBlockSchema = z
  .object({
    taskId: uuidSchema,
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
    reason: z.string().min(1).max(500),
  })
  .strict();

/** PR-B: machine-readable reason a pending task was left unscheduled by planDay. */
export const unscheduledReasonCodeSchema = z.enum([
  "deadline_passed",
  "no_compliant_slot_after_not_before",
  "duration_exceeds_free_slots",
  "no_slot_before_deadline",
  "free_time_exhausted",
]);
export const unscheduledTaskSchema = z
  .object({ taskId: uuidSchema, reason: unscheduledReasonCodeSchema })
  .strict();

/** Why a task sits where it does in an adaptive draft (UX policy §6 reason_codes). */
export const planReasonCodeSchema = z.enum([
  "deadline",
  "retest_due",
  "carry_over",
  "pending_task",
  "weak_skill",
  "review_cards",
  "new_skill",
  "course_pace",
  "repeatedly_skipped",
]);

export const planBlockReasonSchema = z
  .object({ code: planReasonCodeSchema, label: z.string().min(1).max(500) })
  .strict();

/** Tasks the planner proposes; they are created only when the learner accepts the draft. */
export const suggestedTaskSchema = z
  .object({
    /** Becomes the task clientKey on accept. */
    key: z.string().min(8).max(200),
    /** Pre-assigned task id; draft blocks reference it. */
    id: uuidSchema,
    kind: suggestionKindSchema,
    title: z.string().min(1).max(240),
    minutes: z.number().int().positive().max(240),
    courseId: uuidSchema.nullable(),
    skillLabel: z.string().min(1).max(200).nullable(),
    /** Captured target, preserved when the suggestion becomes a task. */
    requirementKey: z.string().max(200).nullable().optional(),
    reasonCode: planReasonCodeSchema,
    reason: z.string().min(1).max(500),
  })
  .strict();

export const planDraftOriginSchema = z.enum(["user", "auto_draft", "coach", "agent"]);

export const planDraftSchema = z
  .object({
    id: uuidSchema,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    version: z.number().int().nonnegative(),
    baseVersion: z.number().int().nonnegative(),
    status: z.enum(["draft", "accepted", "rejected"]),
    blocks: z.array(plannedBlockSchema).max(200),
    unscheduledTaskIds: z.array(uuidSchema).max(200),
    /** PR-B additive: per-task reason for unscheduledTaskIds (same order); optional for older payloads. */
    unscheduled: z.array(unscheduledTaskSchema).max(200).optional(),
    /** Adaptive planning (0061) — omitted for plain drafts. */
    origin: planDraftOriginSchema.optional(),
    suggestedTasks: z.array(suggestedTaskSchema).max(10).optional(),
    reasons: z.record(uuidSchema, planBlockReasonSchema).optional(),
    strategyVersion: z.string().min(1).max(40).optional(),
  })
  .strict();

export const acceptPlanInputSchema = z
  .object({
    draftId: uuidSchema,
    expectedBaseVersion: z.number().int().nonnegative(),
    clientKey: z.string().min(8).max(200),
    /** Suggested-task keys to create with the plan. Omitted = all suggestions in the draft. */
    acceptSuggestedKeys: z.array(z.string().min(8).max(200)).max(10).optional(),
  })
  .strict();

/**
 * Why accepting a stored draft was refused (409 body `reason`). Each one is recoverable:
 * the learner refreshes or reselects instead of retyping anything.
 */
export const planAcceptConflictReasonSchema = z.enum([
  /** The day's plan moved on since the draft was read. */
  "stale_version",
  /** A referenced task was completed, skipped or edited. */
  "task_changed",
  /** A suggestion's course was archived or its material is no longer admissible. */
  "source_unavailable",
  /** A block would now start in the past. */
  "slot_expired",
  /** The same clientKey was replayed with a different suggestion selection. */
  "selection_mismatch",
]);

/** Undo the coach's automatic confirmation for a day. */
export const planUndoInputSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    clientKey: z.string().min(8).max(200),
  })
  .strict();

export const reminderSchema = z
  .object({
    id: uuidSchema,
    taskId: uuidSchema,
    dueAt: isoDateTimeSchema,
    channel: z.enum(["in_app", "feishu"]),
    status: z.enum(["due", "sending", "sent", "failed", "disabled"]),
    /** Null until a provider acknowledges. Never implied by listing. */
    receiptId: z.string().min(1).max(200).nullable(),
    taskVersion: z.number().int().positive(),
    /** Visible when the provider outcome is not a receipt. */
    outcome: z.enum(["acknowledged", "rejected", "unknown", "quiet", "rate_limited"]).nullable(),
  })
  .strict();

export const reminderListSchema = z
  .object({
    reminders: z.array(reminderSchema).max(200),
    /** External push is off unless the owner configured a recipient. */
    externalDelivery: z.enum(["disabled", "configured"]),
  })
  .strict();

const reminderBatchEnqueueInputSchema = z
  .object({
    clientKey: z.string().min(8).max(200),
    channel: z.enum(["in_app", "feishu"]).default("in_app"),
  })
  .strict();

/** A single current occurrence is an explicit action, independent of automatic reminders. */
export const reminderEnqueueInputSchema = z.union([
  reminderBatchEnqueueInputSchema,
  reminderBatchEnqueueInputSchema.extend({
    taskId: uuidSchema,
    expectedVersion: z.number().int().positive(),
  }).strict(),
]);

/**
 * Time-config lifecycle: absolute scheduling requires termStartDate +
 * periodToClock mapping; otherwise display week/period only (RU-05).
 */
export const timeConfigSchema = z
  .object({
    /** Monotonic config version for cross-device conflict (RU-05). */
    version: z.number().int().nonnegative(),
    /** Optional course binding for display name; null = workspace defaults. */
    courseId: uuidSchema.nullable(),
    timeZone: z.string().min(1).max(80).default("Asia/Shanghai"),
    termStartDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    periodToClock: z
      .record(
        z.string().regex(/^\d+$/),
        z
          .object({
            start: z.string().regex(/^\d{2}:\d{2}$/),
            end: z.string().regex(/^\d{2}:\d{2}$/),
          })
          .strict(),
      )
      .nullable(),
  })
  .strict();

export const timeConfigSaveInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    courseId: uuidSchema.nullable(),
    timeZone: z.string().min(1).max(80),
    termStartDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    periodToClock: z
      .record(
        z.string().regex(/^\d+$/),
        z
          .object({
            start: z.string().regex(/^\d{2}:\d{2}$/),
            end: z.string().regex(/^\d{2}:\d{2}$/),
          })
          .strict(),
      )
      .nullable(),
    clientKey: z.string().min(8).max(200),
  })
  .strict();

export type WeekSession = z.infer<typeof weekSessionSchema>;
export type TimeBlock = z.infer<typeof timeBlockSchema>;
export type PlannedBlock = z.infer<typeof plannedBlockSchema>;
export type PlanDraft = z.infer<typeof planDraftSchema>;
export type AcceptPlanInput = z.infer<typeof acceptPlanInputSchema>;
export type PlanAcceptConflictReason = z.infer<typeof planAcceptConflictReasonSchema>;
export type PlanReasonCode = z.infer<typeof planReasonCodeSchema>;
export type PlanBlockReason = z.infer<typeof planBlockReasonSchema>;
export type SuggestionKind = z.infer<typeof suggestionKindSchema>;
export type SuggestedTask = z.infer<typeof suggestedTaskSchema>;
export type PlanDraftOrigin = z.infer<typeof planDraftOriginSchema>;
export type PlanUndoInput = z.infer<typeof planUndoInputSchema>;
export type Reminder = z.infer<typeof reminderSchema>;
export type ReminderList = z.infer<typeof reminderListSchema>;
export type ReminderEnqueueInput = z.infer<typeof reminderEnqueueInputSchema>;
export type TimeConfig = z.infer<typeof timeConfigSchema>;
export type TimeConfigSaveInput = z.infer<
  typeof timeConfigSaveInputSchema
>;

/**
 * Absolute wall-clock scheduling is allowed only when both termStartDate and a
 * non-empty periodToClock map are present. Otherwise UI must show week/period
 * only — never invent calendar dates (RU-05).
 */
export function timeConfigSupportsAbsoluteScheduling(
  config: Pick<TimeConfig, "termStartDate" | "periodToClock">,
): boolean {
  if (config.termStartDate == null) return false;
  const map = config.periodToClock;
  if (map == null) return false;
  return Object.keys(map).length > 0;
}
