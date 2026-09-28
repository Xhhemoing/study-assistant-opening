import { z } from "zod";
import { uuidSchema } from "./foundation";

/** UUID alone is not a candidate identity: assistant and retest have separate stores. */
export const candidateRefSchema = z.discriminatedUnion("origin", [
  z.object({
    origin: z.literal("assistant"),
    kind: z.enum(["task", "memory"]),
    id: uuidSchema,
  }).strict(),
  z.object({
    origin: z.literal("retest"),
    kind: z.literal("retest"),
    id: uuidSchema,
  }).strict(),
]);

export const reviewResultSchema = z.object({
  disposition: z.enum(["applied", "replayed", "already_processed"]),
  resultRef: z.object({
    kind: z.enum(["task", "memory", "retest"]),
    id: uuidSchema,
  }).strict().nullable(),
}).strict();

export type CandidateRef = z.infer<typeof candidateRefSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
