import { z } from "zod";

export const snippetCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(20_000),
  provenanceId: z.string().uuid(),
}).strict();
export const snippetCreateResponseSchema = z.object({ documentId: z.string().uuid() }).strict();
export type SnippetCreateInput = z.infer<typeof snippetCreateInputSchema>;
export type SnippetCreateResponse = z.infer<typeof snippetCreateResponseSchema>;
