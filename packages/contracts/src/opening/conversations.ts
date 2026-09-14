import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

/** Discoverable conversation row — no client-seeded id required (RU-02). */
export const conversationSummarySchema = z
  .object({
    id: uuidSchema,
    title: z.string().min(1).max(200),
    courseId: uuidSchema.nullable(),
    updatedAt: isoDateTimeSchema,
    lastTurnPreview: z.string().max(280).nullable(),
  })
  .strict();

export const providerHistoryMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().max(20_000),
  })
  .strict();

/**
 * Server-assembled resume for provider continuity (RU-02).
 * Clients list/discover then request resume; they do not invent history.
 */
export const conversationResumeSchema = z
  .object({
    conversationId: uuidSchema,
    courseId: uuidSchema.nullable(),
    currentPage: z.number().int().positive().nullable().optional(),
    chunkId: uuidSchema.nullable().optional(),
    sourceIds: z.array(uuidSchema).max(32),
    boundedHistory: z.array(providerHistoryMessageSchema).max(40),
    /** True when older turns exist but were omitted (AC07). */
    historyTruncated: z.boolean(),
  })
  .strict();

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type ConversationResume = z.infer<typeof conversationResumeSchema>;
