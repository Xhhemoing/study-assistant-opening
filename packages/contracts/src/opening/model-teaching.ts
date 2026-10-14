import { z } from "zod";
import { uuidSchema } from "./foundation";

/** Wire format only: model cannot assign identities, verification, grades or permissions. */
export const modelTeachingOutputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  goals: z.array(z.string().trim().min(1).max(500)).min(1).max(6),
  outline: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
  blocks: z.array(z.object({
    type: z.enum(["text", "formula", "example", "prompt"]),
    text: z.string().trim().min(1).max(4000),
    citedChunkIds: z.array(uuidSchema).max(16),
  }).strict()).min(2).max(12),
}).strict().superRefine((value, ctx) => {
  if (!value.blocks.some(block => block.type === "text"))
    ctx.addIssue({ code: "custom", message: "teaching needs an explanation", path: ["blocks"] });
  if (!value.blocks.some(block => block.type === "prompt"))
    ctx.addIssue({ code: "custom", message: "teaching needs a learner attempt", path: ["blocks"] });
});
export type ModelTeachingOutput = z.infer<typeof modelTeachingOutputSchema>;
