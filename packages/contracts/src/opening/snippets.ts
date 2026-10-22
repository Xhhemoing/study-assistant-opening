import { z } from "zod";

const snippetContent = {
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(20_000),
};

/** Exactly one server-owned origin; source references are never supplied by the client. */
export const snippetCreateInputSchema = z.union([
  z.object({ ...snippetContent, provenanceId: z.string().uuid(), savedTurnId: z.never().optional() }).strict(),
  z.object({ ...snippetContent, savedTurnId: z.string().uuid(), provenanceId: z.never().optional() }).strict(),
]);
export const snippetCreateResponseSchema = z.object({ documentId: z.string().uuid() }).strict();
export type SnippetCreateInput = z.infer<typeof snippetCreateInputSchema>;
export type SnippetCreateResponse = z.infer<typeof snippetCreateResponseSchema>;
