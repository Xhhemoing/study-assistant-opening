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

export const searchRequestSchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const searchHitSchema = z.object({
  id: z.string(),
  type: z.enum(["document", "course"]),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
  lifecycle: z.enum(["scratch", "candidate", "confirmed", "published", "archived", "discarded"]).optional(),
  courseMemberships: z.array(z.object({ id: z.string().uuid(), title: z.string() })).optional(),
});

export const searchResponseSchema = z.object({
  hits: z.array(searchHitSchema),
});

export type SearchHit = z.infer<typeof searchHitSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
