import { z } from "zod";
import {
  apiFailureSchema,
  isoDateTimeSchema,
  sha256HexSchema,
  uuidSchema,
} from "./foundation";

export const sourceMimeSchema = z.enum([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
]);

const MAX_NAME = 180;
const IMAGE_MAX = 20 * 1024 * 1024;
const DOCUMENT_MAX = 50 * 1024 * 1024;
const AUDIO_MAX = 200 * 1024 * 1024;

function maxBytesForMime(mime: z.infer<typeof sourceMimeSchema>): number {
  if (mime.startsWith("image/")) return IMAGE_MAX;
  if (mime.startsWith("audio/")) return AUDIO_MAX;
  return DOCUMENT_MAX;
}

export const uploadInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_NAME)
      .refine(
        (name) => !/[\\/\u0000]/.test(name) && !name.includes(".."),
        "name must not contain path separators, NUL, or ..",
      ),
    mime: sourceMimeSchema,
    bytes: z.number().int().positive(),
    sha256: sha256HexSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const max = maxBytesForMime(value.mime);
    if (value.bytes > max) {
      ctx.addIssue({
        code: "custom",
        message: `bytes exceeds max ${max} for ${value.mime}`,
        path: ["bytes"],
      });
    }
  });

export const sourceRecordSchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    name: z.string().min(1).max(MAX_NAME),
    mime: sourceMimeSchema,
    bytes: z.number().int().positive(),
    sha256: sha256HexSchema,
    version: z.number().int().nonnegative(),
    uploadState: z.enum(["pending", "uploaded", "rejected"]),
    parseState: z.enum([
      "not_started",
      "queued",
      "running",
      "ready",
      "failed",
      "unsupported",
    ]),
    error: apiFailureSchema.nullable(),
    /** Course membership projection only — not ownership; null until linked. */
    courseId: uuidSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const uploadTicketSchema = z
  .object({
    source: sourceRecordSchema,
    uploadUrl: z.string().url(),
    expiresAt: isoDateTimeSchema,
  })
  .strict();

/**
 * `page` = physical page index. `slideLabel` = optional PPTX logical label.
 * Never equate them across MIME types. Do not dedupe by text hash.
 * `imageObjectKey` is storage-only — not provider vision input.
 */
export const sourceChunkSchema = z
  .object({
    id: uuidSchema,
    sourceId: uuidSchema,
    sourceVersion: z.number().int().nonnegative(),
    page: z.number().int().positive().nullable(),
    slideLabel: z.string().min(1).max(120).nullable().optional(),
    startMs: z.number().int().nonnegative().nullable(),
    endMs: z.number().int().nonnegative().nullable(),
    text: z.string().max(100_000),
    imageObjectKey: z.string().min(1).max(512).nullable(),
  })
  .strict();

export const citationSchema = z
  .object({
    chunkId: uuidSchema,
    sourceId: uuidSchema,
    sourceVersion: z.number().int().nonnegative(),
    label: z.string().min(1).max(240),
  })
  .strict();

export type SourceMime = z.infer<typeof sourceMimeSchema>;
export type UploadInput = z.infer<typeof uploadInputSchema>;
export type SourceRecord = z.infer<typeof sourceRecordSchema>;
export type UploadTicket = z.infer<typeof uploadTicketSchema>;
export type SourceChunk = z.infer<typeof sourceChunkSchema>;
export type Citation = z.infer<typeof citationSchema>;
