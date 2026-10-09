import { z } from "zod";
import { sha256HexSchema, uuidSchema } from "./foundation";

export const mediaMimeSchema = z.enum(["video/mp4", "video/webm"]);
export const mediaUploadInputSchema = z
  .object({
    name: z.string().min(1).max(180),
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(512 * 1024 * 1024),
    sha256: sha256HexSchema,
  })
  .strict();

export const mediaSegmentSchema = z
  .object({
    sourceId: uuidSchema,
    sourceVersion: z.number().int().nonnegative(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    text: z.string().max(100_000),
    frameChunkIds: z.array(uuidSchema),
    quality: z.enum(["needs_check", "checked"]),
  })
  .strict();

export const mediaSegmentCorrectionInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative().optional(),
    segments: z.array(mediaSegmentSchema).max(2_000),
    clientKey: z.string().min(8).max(200),
  })
  .strict();

export const mediaSegmentsResponseSchema = z
  .object({
    sourceId: uuidSchema,
    sourceVersion: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative().nullable(),
    segments: z.array(mediaSegmentSchema),
    claimsVisualUnderstanding: z.literal(false),
  })
  .strict();

/** Async corrections accept receipt — capability-interfaces CAP03 / V01. */
export const mediaSegmentCorrectionResultSchema = z
  .object({
    jobId: uuidSchema,
  })
  .strict();

export type MediaSegment = z.infer<typeof mediaSegmentSchema>;
export type MediaSegmentCorrectionInput = z.infer<typeof mediaSegmentCorrectionInputSchema>;
export type MediaSegmentsResponse = z.infer<typeof mediaSegmentsResponseSchema>;
export type MediaSegmentCorrectionResult = z.infer<typeof mediaSegmentCorrectionResultSchema>;
