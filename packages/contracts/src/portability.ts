import { z } from "zod";

export const lossEntrySchema = z.object({
  code: z.string().min(1),
  feature: z.string().min(1),
  message: z.string().min(1),
  blockId: z.string().min(1).optional(),
  documentId: z.string().uuid().optional(),
  cardId: z.string().uuid().optional(),
});

export const lossReportSchema = z.object({
  claimedLossless: z.literal(false),
  losses: z.array(lossEntrySchema),
});

export const attachmentManifestEntrySchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  mediaType: z.string().min(1),
  href: z.string().min(1),
});

export const blockIdentitySchema = z.object({
  blockId: z.string().min(1),
  marker: z.string().min(1),
});

export const sourceFileManifestEntrySchema = z.object({
  path: z.string().min(1),
  mediaType: z.string().min(1).optional(),
});

export const portabilityManifestSchema = z.object({
  attachments: z.array(attachmentManifestEntrySchema),
  blockIdentities: z.array(blockIdentitySchema),
  sourceFiles: z.array(sourceFileManifestEntrySchema),
});

export const markdownExportRequestSchema = z.object({
  documentId: z.string().uuid().optional(),
});

export const markdownExportResponseSchema = z.object({
  format: z.literal("markdown"),
  markdown: z.string(),
  manifest: portabilityManifestSchema,
  lossReport: lossReportSchema,
});

export const ankiExportRequestSchema = z.object({
  cardId: z.string().uuid().optional(),
});

export const ankiNoteSchema = z.object({
  id: z.string().uuid(),
  model: z.literal("basic"),
  fields: z.object({
    Front: z.string(),
    Back: z.string(),
    Source: z.string(),
  }),
  tags: z.array(z.string()),
});

export const ankiSchedulingSchema = z.object({
  cardId: z.string().uuid(),
  dueAt: z.string().datetime(),
  intervalDays: z.number().nonnegative(),
  ease: z.number().min(1.3),
  factor: z.number().int(),
  reps: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
});

export const ankiExportResponseSchema = z.object({
  format: z.literal("anki"),
  deckName: z.string().min(1),
  notes: z.array(ankiNoteSchema),
  scheduling: z.array(ankiSchedulingSchema),
  ankiTsv: z.string(),
  manifest: z.object({
    media: z.array(attachmentManifestEntrySchema),
  }),
  lossReport: lossReportSchema,
});

export type LossEntry = z.infer<typeof lossEntrySchema>;
export type LossReport = z.infer<typeof lossReportSchema>;
export type AttachmentManifestEntry = z.infer<typeof attachmentManifestEntrySchema>;
export type BlockIdentity = z.infer<typeof blockIdentitySchema>;
export type SourceFileManifestEntry = z.infer<typeof sourceFileManifestEntrySchema>;
export type PortabilityManifest = z.infer<typeof portabilityManifestSchema>;
export type MarkdownExportRequest = z.infer<typeof markdownExportRequestSchema>;
export type MarkdownExportResponse = z.infer<typeof markdownExportResponseSchema>;
export type AnkiExportRequest = z.infer<typeof ankiExportRequestSchema>;
export type AnkiNote = z.infer<typeof ankiNoteSchema>;
export type AnkiScheduling = z.infer<typeof ankiSchedulingSchema>;
export type AnkiExportResponse = z.infer<typeof ankiExportResponseSchema>;
