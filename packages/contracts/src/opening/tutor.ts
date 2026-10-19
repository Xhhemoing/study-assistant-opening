import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { composerPurposeSchema } from "./composer-purpose";
import { citationSchema, sourceChunkSchema } from "./sources";
import { providerToolCallSchema, providerToolSchema, providerToolMessageSchema, systemQueryReceiptSchema } from "./system-query";

/** Client selection; the server resolves and validates every relationship before use. */
export const studyContextAnchorSchema = z.object({
  courseId: uuidSchema.nullable().optional(),
  activityId: uuidSchema.nullable().optional(),
  blockId: uuidSchema.nullable().optional(),
  contentVersion: z.number().int().positive().nullable().optional(),
  attemptId: uuidSchema.nullable().optional(),
  itemVersionId: uuidSchema.nullable().optional(),
  sourceId: uuidSchema.nullable().optional(),
  sourceVersion: z.number().int().nonnegative().nullable().optional(),
  chunkId: uuidSchema.nullable().optional(),
  page: z.number().int().positive().nullable().optional(),
  kcMappingVersion: z.number().int().nonnegative().nullable().optional(),
  purpose: z.enum(["learning_help", "language_support", "material_read", "note_read", "card_answer", "history_solution", "exam_help", "task_start"]),
}).strict().superRefine((value, ctx) => {
  if (value.blockId && (!value.activityId || value.contentVersion == null)) ctx.addIssue({ code: "custom", path: ["blockId"], message: "block requires activity and content version" });
  if ((value.chunkId || value.sourceVersion != null || value.page != null) && !value.sourceId) ctx.addIssue({ code: "custom", path: ["sourceId"], message: "material selection requires source identity" });
});
export type StudyContextAnchor = z.infer<typeof studyContextAnchorSchema>;

export const studyExposureReceiptSchema = z.object({
  id: uuidSchema,
  releaseKey: z.string().min(8).max(200),
  contextAnchor: studyContextAnchorSchema,
  origin: z.enum(["assistant", "material_excerpt", "note", "card_answer", "history_solution"]),
  supportDomain: z.enum(["language", "math", "unknown"]),
  generatedAt: isoDateTimeSchema,
  releasedAt: isoDateTimeSchema.nullable(),
  acknowledgedAt: isoDateTimeSchema.nullable(),
  historyRevision: z.number().int().nonnegative(),
}).strict();
export type StudyExposureReceipt = z.infer<typeof studyExposureReceiptSchema>;

export const tutorModeSchema = z.enum([
  "hint",
  "explain",
  "listen",
  "think_together",
]);

/**
 * TurnInput: conversationId is always required and must be server-issued
 * (create or discover first — never pre-seed across devices). Optional
 * currentPage/chunkId are server-validated membership selections (RU-03) —
 * never invent a page when both are absent. File selection is not page selection.
 */
function validateSourceSelection(value: { sourceSelection?: string; sourceIds: string[]; currentPage?: number | null; chunkId?: string | null; attemptId?: string | null; contextAnchor?: { sourceId?: string | null; sourceVersion?: number | null; page?: number | null; chunkId?: string | null; attemptId?: string | null; itemVersionId?: string | null } }, ctx: z.RefinementCtx) {
  if (value.sourceSelection === "selected" && !value.sourceIds.length) ctx.addIssue({ code: "custom", path: ["sourceIds"], message: "请先选择至少一份资料。" });
  if ((value.sourceSelection === "none" || value.sourceSelection === "auto") && value.sourceIds.length) ctx.addIssue({ code: "custom", path: ["sourceIds"], message: "自动或不用资料时不能携带手选资料。" });
  if (value.sourceSelection === "none" && (value.currentPage != null || value.chunkId || value.attemptId || value.contextAnchor?.sourceId || value.contextAnchor?.sourceVersion != null || value.contextAnchor?.page != null || value.contextAnchor?.chunkId || value.contextAnchor?.attemptId || value.contextAnchor?.itemVersionId)) ctx.addIssue({ code: "custom", path: ["sourceSelection"], message: "不用资料时不能指定原文位置。" });
}

export const turnInputSchema = z
  .object({
    conversationId: uuidSchema,
    contextAnchor: studyContextAnchorSchema.optional(),
    text: z.string().min(1).max(20_000),
    sourceIds: z.array(uuidSchema).max(32),
    sourceSelection: z.enum(["auto", "selected", "none"]).optional(),
    mode: tutorModeSchema,
    clientKey: z.string().min(8).max(200),
    privacy: z.enum(["saved", "ephemeral"]),
    learningSessionId: uuidSchema.nullable().optional(),
    attemptId: uuidSchema.nullable().optional(),
    currentPage: z.number().int().positive().nullable().optional(),
    chunkId: uuidSchema.nullable().optional(),
    strategyTemplateId: z.string().min(1).max(100).optional(),
    purpose: composerPurposeSchema.optional(),
    querySystem: z.boolean().optional(),
  })
  .strict().superRefine(validateSourceSelection);

export const providerMediaCapabilitySchema = z.enum([
  "text_only",
  "text_plus_page_images",
  "refused",
]);

/** Real image parts that reach the model — not storage keys alone. */
export const providerImagePartSchema = z
  .object({
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    /** data URL or vendor file id after authorized fetch — never a raw object key */
    data: z.string().min(1).max(12_000_000),
    detail: z.enum(["auto", "low", "high"]).optional(),
    sourceId: uuidSchema.optional(),
    physicalPage: z.number().int().positive().optional(),
  })
  .strict();

/**
 * ProviderInput: imageObjectKey on chunks is storage-only.
 * Vision-necessary turns must attach `imageParts` or set mediaCapability=refused.
 */
export const providerInputSchema = z
  .object({
    instruction: z.string().min(1).max(50_000),
    text: z.string().max(50_000),
    chunks: z.array(sourceChunkSchema).max(64),
    history: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      text: z.string().max(12_000),
    }).strict()).max(40).refine((turns) => turns.reduce((sum, turn) => sum + turn.text.length, 0) <= 12_000,
      "history exceeds character budget").optional(),
    mode: tutorModeSchema,
    maxOutputTokens: z.number().int().positive().max(16_384),
    mediaCapability: providerMediaCapabilitySchema,
    imageParts: z.array(providerImagePartSchema).max(32).default([]),
    /** "answer" (default) = tutor answer shape; "json" = task-specific JSON object returned in `text`. */
    outputFormat: z.enum(["answer", "json"]).optional(),
    tools: z.array(providerToolSchema).max(16).optional(),
    toolMessages: z.array(providerToolMessageSchema).max(12).optional(),
    /** Raw base64 audio (no data: prefix) for models with audio input. */
    audioParts: z.array(z.object({
      data: z.string().min(1).max(30_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
      format: z.enum(["wav", "mp3"]),
    }).strict()).max(8).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const registered = new Set(value.tools?.map(tool => tool.name) ?? []);
    if (registered.size !== (value.tools?.length ?? 0)) ctx.addIssue({ code: "custom", message: "duplicate tool registration", path: ["tools"] });
    const used = new Set<string>(), pending = new Set<string>();
    for (const message of value.toolMessages ?? []) {
      if (message.role === "assistant") {
        if (pending.size) ctx.addIssue({ code: "custom", message: "unanswered tool call", path: ["toolMessages"] });
        for (const call of message.calls) {
          if (!registered.has(call.name) || used.has(call.id)) ctx.addIssue({ code: "custom", message: "unregistered or duplicate tool call", path: ["toolMessages"] });
          used.add(call.id); pending.add(call.id);
        }
      } else if (!pending.delete(message.callId)) ctx.addIssue({ code: "custom", message: "orphan or duplicate tool result", path: ["toolMessages"] });
    }
    if (pending.size) ctx.addIssue({ code: "custom", message: "unanswered tool call", path: ["toolMessages"] });
    if (
      value.mediaCapability === "text_plus_page_images" &&
      value.imageParts.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "text_plus_page_images requires real imageParts (imageObjectKey alone is not enough)",
        path: ["imageParts"],
      });
    }
  });

export const assistantCandidateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("memory"),
      text: z.string().min(1).max(4000),
      temporary: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task"),
      title: z.string().min(1).max(240),
      minutes: z.number().int().positive().nullable(),
      dueText: z.string().max(240).nullable(),
    })
    .strict(),
]);

export const assistantCandidateRecordSchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    version: z.number().int().nonnegative(),
    candidate: assistantCandidateSchema,
    sourceTurnId: uuidSchema,
    sourceIds: z.array(uuidSchema).max(32),
    status: z.enum(["pending", "accepted", "rejected"]),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const providerOutputSchema = z
  .object({
    text: z.string().max(50_000),
    citedChunkIds: z.array(uuidSchema).max(64),
    requestId: z.string().max(200).nullable(),
    candidates: z.array(assistantCandidateSchema).max(16),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    toolCalls: z.array(providerToolCallSchema).max(4).optional(),
  })
  .strict();

/**
 * Assistant/user turn lifecycle. `clarify` (LAB-U01) is the terminal state of
 * a page-citation refusal: a Clarify follow-up, not a failure.
 */
export const turnStatusSchema = z.enum(["pending", "complete", "failed", "clarify", "outcome_unknown"]);

/** Turns in these states are final: sweepers and recovery writers never rewrite them. */
export const TERMINAL_TURN_STATUSES = ["complete", "failed", "clarify", "outcome_unknown"] as const;

/**
 * Terminal assistant-turn status for a failed tutor job. A job error that
 * routes to Clarify (`nextAction: "clarify"`) ends the turn as `clarify`.
 */
export function terminalTurnStatusForJobError(
  error: { nextAction?: "clarify" } | null | undefined,
): "failed" | "clarify" {
  return error?.nextAction === "clarify" ? "clarify" : "failed";
}

export const turnRecordSchema = z
  .object({
    id: uuidSchema,
    conversationId: uuidSchema,
    role: z.enum(["user", "assistant"]),
    text: z.string().max(50_000),
    citations: z.array(citationSchema).max(64),
    createdAt: isoDateTimeSchema,
    mode: tutorModeSchema,
    status: turnStatusSchema,
    contextAnchor: studyContextAnchorSchema.nullable().optional(),
    exposureReceipt: studyExposureReceiptSchema.nullable().optional(),
    systemQuery: systemQueryReceiptSchema.nullable().optional(),
  })
  .strict();

export const budgetReservationSchema = z
  .object({
    id: uuidSchema,
    requestKey: z.string().min(1).max(200),
    jobId: uuidSchema.nullable(),
    reservedCents: z.number().int().nonnegative(),
  })
  .strict();

export const ephemeralTurnResponseSchema = providerOutputSchema.extend({
  contextAnchor: studyContextAnchorSchema.optional(),
  exposureReceipt: studyExposureReceiptSchema.optional(),
  systemQuery: systemQueryReceiptSchema.optional(),
  provenanceId: uuidSchema.nullable().default(null),
  privacyEpoch: z.number().int().nonnegative(),
  historyDiscarded: z.boolean(),
  /** Program-resolved cites for UI chips; unknown ids filtered, never fabricated. */
  citations: z.array(citationSchema).max(64).default([]),
  /**
   * Present only when the server changed source selection vs client input
   * (empty client → course-pool fill and/or auto top-K pick). Omit when the
   * client sent explicit non-empty sourceIds used as-is.
   */
  effectiveSourceIds: z.array(uuidSchema).max(32).optional(),
}).strict();

export const ephemeralTurnInputSchema = z
  .object({
    contextAnchor: studyContextAnchorSchema.optional(),
    clientKey: z.string().min(8).max(160).optional(),
    purpose: composerPurposeSchema.optional(),
    querySystem: z.boolean().optional(),
    historyPrivacyEpoch: z.number().int().nonnegative().optional(),
    text: z.string().min(1).max(20_000),
    sourceIds: z.array(uuidSchema).max(32),
    sourceSelection: z.enum(["auto", "selected", "none"]).optional(),
    mode: tutorModeSchema,
    history: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            text: z.string().max(20_000),
            provenanceId: uuidSchema.optional(),
          })
          .strict(),
      )
      .max(40),
    currentPage: z.number().int().positive().nullable().optional(),
    chunkId: uuidSchema.nullable().optional(),
    /** Optional course scope for Package B/C pool fill when sourceIds are empty. */
    courseId: uuidSchema.nullable().optional(),
  })
  .strict().superRefine(validateSourceSelection);

export const conversationCreateInputSchema = z
  .object({
    title: z.string().min(1).max(200),
    courseId: uuidSchema.nullable(),
  })
  .strict();

export type TutorMode = z.infer<typeof tutorModeSchema>;
export type TurnInput = z.infer<typeof turnInputSchema>;
export type ProviderInput = z.infer<typeof providerInputSchema>;
export type ProviderOutput = z.infer<typeof providerOutputSchema>;
export type TurnRecord = z.infer<typeof turnRecordSchema>;
export type TurnStatus = z.infer<typeof turnStatusSchema>;
export type BudgetReservation = z.infer<typeof budgetReservationSchema>;
export type EphemeralTurnResponse = z.infer<typeof ephemeralTurnResponseSchema>;
export type EphemeralTurnInput = z.infer<typeof ephemeralTurnInputSchema>;
export type AssistantCandidate = z.infer<typeof assistantCandidateSchema>;
export type AssistantCandidateRecord = z.infer<
  typeof assistantCandidateRecordSchema
>;
export type ConversationCreateInput = z.infer<
  typeof conversationCreateInputSchema
>;
