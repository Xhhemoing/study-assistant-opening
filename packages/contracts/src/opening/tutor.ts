import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { citationSchema, sourceChunkSchema } from "./sources";

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
export const turnInputSchema = z
  .object({
    conversationId: uuidSchema,
    text: z.string().min(1).max(20_000),
    sourceIds: z.array(uuidSchema).max(32),
    mode: tutorModeSchema,
    clientKey: z.string().min(8).max(200),
    privacy: z.enum(["saved", "ephemeral"]),
    learningSessionId: uuidSchema.nullable().optional(),
    currentPage: z.number().int().positive().nullable().optional(),
    chunkId: uuidSchema.nullable().optional(),
  })
  .strict();

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
    mode: tutorModeSchema,
    maxOutputTokens: z.number().int().positive().max(16_384),
    mediaCapability: providerMediaCapabilitySchema,
    imageParts: z.array(providerImagePartSchema).max(32).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
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
  })
  .strict();

export const turnRecordSchema = z
  .object({
    id: uuidSchema,
    conversationId: uuidSchema,
    role: z.enum(["user", "assistant"]),
    text: z.string().max(50_000),
    citations: z.array(citationSchema).max(64),
    createdAt: isoDateTimeSchema,
    mode: tutorModeSchema,
    status: z.enum(["pending", "complete", "failed"]),
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

export const ephemeralTurnInputSchema = z
  .object({
    text: z.string().min(1).max(20_000),
    sourceIds: z.array(uuidSchema).max(32),
    mode: tutorModeSchema,
    history: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            text: z.string().max(20_000),
          })
          .strict(),
      )
      .max(40),
    currentPage: z.number().int().positive().nullable().optional(),
    chunkId: uuidSchema.nullable().optional(),
  })
  .strict();

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
export type BudgetReservation = z.infer<typeof budgetReservationSchema>;
export type EphemeralTurnInput = z.infer<typeof ephemeralTurnInputSchema>;
export type AssistantCandidate = z.infer<typeof assistantCandidateSchema>;
export type AssistantCandidateRecord = z.infer<
  typeof assistantCandidateRecordSchema
>;
export type ConversationCreateInput = z.infer<
  typeof conversationCreateInputSchema
>;
