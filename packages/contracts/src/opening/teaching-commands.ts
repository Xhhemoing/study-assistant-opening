import { z } from "zod";
import { activitySpecClientInitSchema } from "./teaching-content";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

export const TEACHING_COMMAND_LOG_MAX = 32;
export const TEACHING_BRANCH_STACK_MAX = 16;

export const teachingCommandKindSchema = z.enum([
  "confused",
  "why",
  "rephrase",
  "expand",
  "example",
  "skip",
  "branch",
  "return",
]);
export type TeachingCommandKind = z.infer<typeof teachingCommandKindSchema>;

export const teachingCommandRequestSchema = z
  .object({
    clientKey: z.string().min(8).max(200),
    kind: teachingCommandKindSchema,
    /** Required for all kinds except `return` (may omit when popping). */
    blockId: uuidSchema.optional(),
    expectedVersion: z.number().int().nonnegative(),
    expectedPathVersion: z.number().int().positive().optional(),
    expectedRevisionNumber: z.number().int().positive().optional(),
    prompt: z.string().max(2000).optional(),
    branchLabel: z.string().max(200).optional(),
    targetBlockId: uuidSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind !== "return" && value.blockId == null) {
      ctx.addIssue({
        code: "custom",
        path: ["blockId"],
        message: "blockId is required for this command kind",
      });
    }
  });
export type TeachingCommandRequest = z.infer<typeof teachingCommandRequestSchema>;

export const teachingBranchFrameSchema = z
  .object({
    frameId: uuidSchema,
    fromBlockId: uuidSchema,
    resumeBlockId: uuidSchema.optional(),
    contentVersion: z.number().int().nonnegative(),
    pathVersion: z.number().int().positive(),
    label: z.string().max(200).optional(),
    createdAt: isoDateTimeSchema,
  })
  .strict();
export type TeachingBranchFrame = z.infer<typeof teachingBranchFrameSchema>;

export const teachingCommandLogEntrySchema = z
  .object({
    clientKey: z.string().min(8).max(200),
    kind: teachingCommandKindSchema,
    blockId: uuidSchema.optional(),
    at: isoDateTimeSchema,
    result: z.enum(["ok", "conflict", "rejected"]),
    contentVersionAfter: z.number().int().nonnegative().optional(),
    pathVersionAfter: z.number().int().positive().optional(),
    revisionNumberAfter: z.number().int().positive().optional(),
    /** Stable intent fingerprint for soft-idempotent replay / mismatch. */
    intentFingerprint: z.string().min(1).max(500).optional(),
  })
  .strict();
export type TeachingCommandLogEntry = z.infer<typeof teachingCommandLogEntrySchema>;

export const teachingCommandConflictCodeSchema = z.enum([
  "stale_content_version",
  "stale_path_version",
  "stale_revision",
  "client_key_intent_mismatch",
  "block_not_in_spec",
  "branch_stack_empty",
  "generate_in_flight",
  "draft_anchor_lost",
  "validation",
]);
export type TeachingCommandConflictCode = z.infer<
  typeof teachingCommandConflictCodeSchema
>;

export const teachingCommandAssistSchema = z
  .object({
    kind: z.enum(["why", "confused"]),
    summary: z.string().min(1).max(4000),
  })
  .strict();
export type TeachingCommandAssist = z.infer<typeof teachingCommandAssistSchema>;

export const teachingCommandSuccessSchema = z
  .object({
    ok: z.literal(true),
    kind: teachingCommandKindSchema,
    activityId: uuidSchema,
    contentVersion: z.number().int().nonnegative(),
    pathVersion: z.number().int().positive(),
    revisionNumber: z.number().int().positive().optional(),
    checkpointJson: z.record(z.string(), z.unknown()),
    clientInit: activitySpecClientInitSchema.optional(),
    replayed: z.boolean(),
    assist: teachingCommandAssistSchema.optional(),
  })
  .strict();
export type TeachingCommandSuccess = z.infer<typeof teachingCommandSuccessSchema>;

export const teachingCommandConflictSchema = z
  .object({
    ok: z.literal(false),
    conflict: teachingCommandConflictCodeSchema,
    message: z.string().min(1).max(2000),
    currentContentVersion: z.number().int().nonnegative().optional(),
    currentPathVersion: z.number().int().positive().optional(),
    currentRevisionNumber: z.number().int().positive().optional(),
    lostBlockIds: z.array(uuidSchema).min(1).optional(),
  })
  .strict();
export type TeachingCommandConflict = z.infer<typeof teachingCommandConflictSchema>;

export const teachingCommandResponseSchema = z.discriminatedUnion("ok", [
  teachingCommandSuccessSchema,
  teachingCommandConflictSchema,
]);
export type TeachingCommandResponse = z.infer<typeof teachingCommandResponseSchema>;

/** Kinds that append a new library Revision + bump content_version. */
export const TEACHING_REWRITE_KINDS = ["rephrase", "expand", "example"] as const;
export type TeachingRewriteKind = (typeof TEACHING_REWRITE_KINDS)[number];

export function isTeachingRewriteKind(kind: TeachingCommandKind): kind is TeachingRewriteKind {
  return (TEACHING_REWRITE_KINDS as readonly string[]).includes(kind);
}

/** Kinds that bump path_version only (no library body change). */
export const TEACHING_PATH_KINDS = ["skip", "branch", "return"] as const;
export type TeachingPathKind = (typeof TEACHING_PATH_KINDS)[number];

export function isTeachingPathKind(kind: TeachingCommandKind): kind is TeachingPathKind {
  return (TEACHING_PATH_KINDS as readonly string[]).includes(kind);
}
