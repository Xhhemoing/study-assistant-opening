import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { candidateRefSchema, reviewResultSchema } from "./candidate-review";

/** Read-model projection for a task created from an accepted retest proposal. */
export const taskRetestProjectionSchema = z.object({
  candidateId: uuidSchema,
  activityId: uuidSchema,
  courseId: uuidSchema,
  skillLabel: z.string().min(1).max(200),
  prompt: z.string().min(1).max(4000),
  recommendedAt: isoDateTimeSchema.nullable(),
}).strict();

/** Who put the task in the queue. `planner`/`agent` tasks only exist after the learner accepted a draft. */
export const taskOriginSchema = z.enum(["manual", "course_seed", "retest", "planner", "agent"]);

export const taskItemSchema = z.object({
  id: uuidSchema,
  version: z.number().int().positive().optional(),
  title: z.string().min(1).max(240),
  minutes: z.number().int().positive().max(24 * 60),
  dueAt: isoDateTimeSchema.nullable(),
  priority: z.number().finite(),
  status: z.enum(["pending", "done", "skipped"]),
  /** Present for retest-origin tasks; null/omitted for ordinary tasks. */
  retest: taskRetestProjectionSchema.nullable().optional(),
  /** Adaptive planning (0061); omitted when unset. */
  courseId: uuidSchema.optional(),
  skillLabel: z.string().min(1).max(200).optional(),
  /** Omitted for `manual`. */
  origin: taskOriginSchema.optional(),
  /** Planners must not place the task before this instant (deferral). */
  notBefore: isoDateTimeSchema.optional(),
  /** Course study plan (0065): which lessons this task teaches or reviews. */
  studyPlan: z.object({
    kind: z.enum(["lesson", "review"]),
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lessonNumbers: z.array(z.number().int().positive()).max(100),
  }).strict().optional(),
}).strict();

/** Stored with a retest-origin task. Not a calendar schedule. */
export const retestTaskSnapshotSchema = z.object({
  kind: z.literal("retest"),
  candidateId: uuidSchema,
  courseId: uuidSchema.optional(),
  skillLabel: z.string().min(1).max(200).optional(),
  prompt: z.string().min(1).max(4000).optional(),
  sourceIds: z.array(uuidSchema).max(32).optional(),
  dueAt: isoDateTimeSchema.nullable().optional(),
  heuristic: z.literal(true),
}).strict();

export const taskCreateInputSchema = z.object({
  title: z.string().min(1).max(240),
  minutes: z.number().int().positive().max(24 * 60),
  dueAt: isoDateTimeSchema.nullable(),
  /** Ambiguous deadline text — never auto-promoted to dueAt. */
  dueText: z.string().min(1).max(200).nullable().optional(),
  priority: z.number().finite(),
  candidateId: uuidSchema.nullable(),
  /** Optional for old clients; server-side owner/type validation is always required. */
  candidateRef: candidateRefSchema.optional(),
  /** Idempotency key when accepting an assistant or retest candidate into a task. */
  clientKey: z.string().min(8).max(200).optional(),
  /** Assistant candidate version: pending is 0; replays compare the original value. */
  expectedVersion: z.number().int().nonnegative().optional(),
  /** Plan version the retest snapshot was based on. Not calendar scheduling. */
  baseVersion: z.number().int().nonnegative().optional(),
  inputSnapshot: retestTaskSnapshotSchema.optional(),
  /** Owned, unarchived course; checked by the repository. */
  courseId: uuidSchema.nullable().optional(),
  skillLabel: z.string().min(1).max(200).nullable().optional(),
  /** Client-settable origins only; retest/planner/agent are assigned server-side. */
  origin: z.enum(["manual", "course_seed"]).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.dueText && value.dueAt) {
    ctx.addIssue({ code: "custom", message: "dueText cannot become a formal deadline while dueAt is set", path: ["dueText"] });
  }
  if (value.inputSnapshot && value.inputSnapshot.candidateId !== value.candidateId) {
    ctx.addIssue({ code: "custom", message: "inputSnapshot.candidateId must match candidateId", path: ["inputSnapshot"] });
  }
  const ref = value.candidateRef;
  if (!ref) return;
  if (ref.id !== value.candidateId) {
    ctx.addIssue({ code: "custom", message: "candidateRef.id must match candidateId", path: ["candidateRef", "id"] });
  }
  if (ref.kind === "memory") {
    ctx.addIssue({ code: "custom", message: "memory candidates require a memory decision", path: ["candidateRef", "kind"] });
  }
  if ((ref.origin === "retest") !== (value.inputSnapshot?.kind === "retest")) {
    ctx.addIssue({ code: "custom", message: "candidate origin must match the task snapshot", path: ["candidateRef", "origin"] });
  }
});

/** Explicit candidateRef clients receive review metadata; legacy responses remain flat. */
export const taskCreateResultSchema = taskItemSchema.extend({ reviewResult: reviewResultSchema.optional() });
export const taskStatusUpdateInputSchema = z.object({
  status: z.enum(["done", "skipped"]),
  expectedVersion: z.number().int().positive(),
  at: isoDateTimeSchema,
}).strict();
/** Defer a pending task: planners skip it until `notBefore` (null clears the deferral). */
export const taskDeferInputSchema = z.object({
  notBefore: isoDateTimeSchema.nullable(),
  expectedVersion: z.number().int().positive(),
}).strict();
export type TaskCreateResult = z.infer<typeof taskCreateResultSchema>;
export type TaskStatusUpdateInput = z.infer<typeof taskStatusUpdateInputSchema>;
export type TaskDeferInput = z.infer<typeof taskDeferInputSchema>;
export type TaskOrigin = z.infer<typeof taskOriginSchema>;

export type TaskItem = z.infer<typeof taskItemSchema>;
export type TaskRetestProjection = z.infer<typeof taskRetestProjectionSchema>;
export type TaskCreateInput = z.infer<typeof taskCreateInputSchema>;
