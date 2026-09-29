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
  "video/mp4",
  "video/webm",
  "message/rfc822",
  "text/markdown",
  "text/html",
  "application/vnd.ms-powerpoint",
]);

const MAX_NAME = 180;
const IMAGE_MAX = 20 * 1024 * 1024;
const DOCUMENT_MAX = 50 * 1024 * 1024;
const AUDIO_MAX = 200 * 1024 * 1024;

function maxBytesForMime(mime: z.infer<typeof sourceMimeSchema>): number {
  if (mime.startsWith("image/")) return IMAGE_MAX;
  if (mime.startsWith("audio/")) return AUDIO_MAX;
  if (mime.startsWith("video/")) return 512 * 1024 * 1024;
  if (mime === "message/rfc822") return 25 * 1024 * 1024;
  if (mime === "text/markdown" || mime === "text/html") return DOCUMENT_MAX;
  if (mime === "application/vnd.ms-powerpoint") return DOCUMENT_MAX;
  return DOCUMENT_MAX;
}

export const uploadInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_NAME)
      .refine(
        (name) => !name.includes("..") && !["\\", "/", "\u0000"].some((bad) => name.includes(bad)),
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

export const sourceDownloadSchema = z
  .object({
    url: z.string().url(),
    expiresAt: isoDateTimeSchema,
    version: z.number().int().nonnegative(),
    currentVersion: z.number().int().nonnegative(),
    versionMismatch: z.boolean(),
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
export type SourceDownload = z.infer<typeof sourceDownloadSchema>;
export type SourceChunk = z.infer<typeof sourceChunkSchema>;
export type Citation = z.infer<typeof citationSchema>;

/** RU-01: attach opening source to a course via membership (not ownership). */
export const sourceCourseLinkInputSchema = z
  .object({
    sourceId: uuidSchema,
    courseId: uuidSchema,
    clientKey: z.string().min(8).max(200),
  })
  .strict();

export const sourceCourseUnlinkInputSchema = z
  .object({
    sourceId: uuidSchema,
    courseId: uuidSchema,
    clientKey: z.string().min(8).max(200),
  })
  .strict();

export type SourceCourseLinkInput = z.infer<typeof sourceCourseLinkInputSchema>;
export type SourceCourseUnlinkInput = z.infer<typeof sourceCourseUnlinkInputSchema>;

const sourceConfirmation = {
  expectedVersion: z.number().int().nonnegative(),
  expectedMembershipIds: z.array(uuidSchema).max(1000),
};

export const sourceActionInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("exclude"), ...sourceConfirmation }).strict(),
  z.object({ action: z.literal("delete"), ...sourceConfirmation }).strict(),
  z.object({ action: z.literal("retry_cleanup") }).strict(),
]);

export const sourceImpactSchema = z.object({
  sourceId: uuidSchema,
  version: z.number().int().nonnegative(),
  aiExcluded: z.boolean(),
  courses: z.array(z.object({
    membershipId: uuidSchema,
    courseId: uuidSchema,
    title: z.string(),
    archivedAt: isoDateTimeSchema.nullable(),
  }).strict()),
}).strict();

export const sourceActionResultSchema = z.object({
  sourceId: uuidSchema,
  aiExcluded: z.boolean(),
  deleted: z.boolean(),
  cleanupPending: z.number().int().nonnegative(),
  retryAfter: isoDateTimeSchema.nullable(),
}).strict();

export const sourceDeletionListSchema = z.array(sourceActionResultSchema.pick({ sourceId: true, cleanupPending: true, retryAfter: true }));
export type SourceActionInput = z.infer<typeof sourceActionInputSchema>;
export type SourceImpact = z.infer<typeof sourceImpactSchema>;
export type SourceActionResult = z.infer<typeof sourceActionResultSchema>;
export type SourceDeletion = z.infer<typeof sourceDeletionListSchema>[number];
