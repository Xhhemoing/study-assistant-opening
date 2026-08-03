import { z } from "zod";

export const searchableDocumentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  blocks: z.array(z.object({
    type: z.string().min(1),
    content: z.record(z.string(), z.unknown()),
  })).optional(),
});

export const searchableDocumentsResponseSchema = z.object({
  documents: z.array(searchableDocumentSchema).default([]),
});

export type SearchableDocument = z.infer<typeof searchableDocumentSchema>;
