import { z } from "zod";
import { uuidSchema } from "./foundation";

export const photoWorkSourceInputSchema = z.object({
  sourceId: uuidSchema,
  sourceVersion: z.number().int().nonnegative(),
  physicalPage: z.number().int().positive(),
}).strict();

export const photoWorkSourceResponseSchema = z.object({
  attemptId: uuidSchema,
  courseId: uuidSchema,
  workSource: z.object({
    id: uuidSchema,
    version: z.number().int().nonnegative(),
    physicalPage: z.number().int().positive(),
  }).strict(),
  state: z.enum(["ready", "pending", "unavailable"]),
  parseState: z.enum(["not_started", "queued", "running", "ready", "failed", "unsupported"]).nullable(),
}).strict();

export type PhotoWorkSourceInput = z.infer<typeof photoWorkSourceInputSchema>;
export type PhotoWorkSourceResponse = z.infer<typeof photoWorkSourceResponseSchema>;