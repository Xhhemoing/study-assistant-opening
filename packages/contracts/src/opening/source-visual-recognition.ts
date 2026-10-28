import { z } from "zod";

const readable = z.string().refine(value => !Array.from(value).some(character => {
  const code = character.charCodeAt(0);
  return code < 32 && code !== 9 && code !== 10 && code !== 13;
}), "invalid control character in transcription");

/** Extraction is evidence to inspect, never a learning verdict. */
export const sourceVisualRecognitionOutputSchema = z.object({
  transcription: readable.pipe(z.string().trim().max(24_000)),
  description: readable.pipe(z.string().trim().max(4_000)),
  uncertainties: z.array(readable.pipe(z.string().trim().min(1).max(500))).max(30),
  contentKinds: z.array(z.enum(["text", "handwriting", "formula", "table", "chart"])).max(5)
    .refine(value => new Set(value).size === value.length, "duplicate content kind"),
}).strict().refine(value => Boolean(value.transcription || value.description), "no readable visual content");
export type SourceVisualRecognitionOutput = z.infer<typeof sourceVisualRecognitionOutputSchema>;
