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
export type TaskCreateResult = z.infer<typeof taskCreateResultSchema>;
export type TaskStatusUpdateInput = z.infer<typeof taskStatusUpdateInputSchema>;

export type TaskItem = z.infer<typeof taskItemSchema>;
export type TaskRetestProjection = z.infer<typeof taskRetestProjectionSchema>;
export type TaskCreateInput = z.infer<typeof taskCreateInputSchema>;
