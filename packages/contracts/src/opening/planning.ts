import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

export const weekSessionSchema = z
  .object({
    courseName: z.string().min(1).max(200),
    /** Optional course binding; courseName remains the timetable display label (RU-05). */
    courseId: uuidSchema.nullable().optional(),
    weekday: z.number().int().min(0).max(6),
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

export const taskItemSchema = z
  .object({
    id: uuidSchema,
    title: z.string().min(1).max(240),
    minutes: z.number().int().positive().max(24 * 60),
    dueAt: isoDateTimeSchema.nullable(),
    priority: z.number().finite(),
    status: z.enum(["pending", "done", "skipped"]),
  })
  .strict();

/** Stored with a retest-origin task. Not a calendar schedule. */
export const retestTaskSnapshotSchema = z
  .object({
    kind: z.literal("retest"),
    candidateId: uuidSchema,
    courseId: uuidSchema.optional(),
    skillLabel: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).max(4000).optional(),
    sourceIds: z.array(uuidSchema).max(32).optional(),
    dueAt: isoDateTimeSchema.nullable().optional(),
    heuristic: z.literal(true),
  })
  .strict();

export const taskCreateInputSchema = z
  .object({
    title: z.string().min(1).max(240),
    minutes: z.number().int().positive().max(24 * 60),
    dueAt: isoDateTimeSchema.nullable(),
    /** Ambiguous deadline text — never auto-promoted to dueAt. */
    dueText: z.string().min(1).max(200).nullable().optional(),
    priority: z.number().finite(),
    candidateId: uuidSchema.nullable(),
    /** Idempotency key when accepting a retest candidate into a task. */
    clientKey: z.string().min(8).max(200).optional(),
    /** Plan version the retest snapshot was based on. Not calendar scheduling. */
    baseVersion: z.number().int().nonnegative().optional(),
    inputSnapshot: retestTaskSnapshotSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dueText && value.dueAt) {
      ctx.addIssue({
        code: "custom",
        message: "dueText cannot become a formal deadline while dueAt is set",
        path: ["dueText"],
      });
    }
    if (value.inputSnapshot && value.candidateId && value.inputSnapshot.candidateId !== value.candidateId) {
      ctx.addIssue({
        code: "custom",
        message: "inputSnapshot.candidateId must match candidateId",
        path: ["inputSnapshot"],
      });
    }
  });

export const plannedBlockSchema = z
  .object({
    taskId: uuidSchema,
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
    reason: z.string().min(1).max(500),
  })
  .strict();

export const planDraftSchema = z
  .object({
    id: uuidSchema,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    version: z.number().int().nonnegative(),
    baseVersion: z.number().int().nonnegative(),
    status: z.enum(["draft", "accepted", "rejected"]),
    blocks: z.array(plannedBlockSchema).max(200),
    unscheduledTaskIds: z.array(uuidSchema).max(200),
  })
  .strict();

export const acceptPlanInputSchema = z
  .object({
    draftId: uuidSchema,
    expectedBaseVersion: z.number().int().nonnegative(),
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

export const reminderEnqueueInputSchema = z
  .object({
    clientKey: z.string().min(8).max(200),
    channel: z.enum(["in_app", "feishu"]).default("in_app"),
  })
  .strict();

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
export type TaskItem = z.infer<typeof taskItemSchema>;
export type TaskCreateInput = z.infer<typeof taskCreateInputSchema>;
export type PlannedBlock = z.infer<typeof plannedBlockSchema>;
export type PlanDraft = z.infer<typeof planDraftSchema>;
export type AcceptPlanInput = z.infer<typeof acceptPlanInputSchema>;
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
