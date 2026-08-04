import { z } from "zod";

const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 80;

export const documentTagSchema = z.string().min(1).max(MAX_TAG_LENGTH);
export const documentTagsSchema = z.array(documentTagSchema).max(MAX_TAGS);
export const documentTagsResponseSchema = z.object({ tags: documentTagsSchema });

export function normalizeDocumentTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const tag of tags) {
    const value = tag.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!value) throw new Error("Tag must not be empty");
    if (value.length > MAX_TAG_LENGTH) throw new Error("Tag exceeds 80 characters");
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(value);
    }
  }

  if (normalized.length > MAX_TAGS) throw new Error("Too many tags");
  return normalized;
}

export const documentTagsUpdateSchema = z.object({
  tags: z.array(z.string()).superRefine((tags, context) => {
    try {
      normalizeDocumentTags(tags);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid document tags",
      });
    }
  }),
});

export type DocumentTags = z.infer<typeof documentTagsResponseSchema>;
export type DocumentTagsUpdate = z.infer<typeof documentTagsUpdateSchema>;
