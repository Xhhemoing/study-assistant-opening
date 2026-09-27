import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

/** Initial user decision for an assistant memory candidate. Version stays 0 until consumed. */
export const memoryCandidateDecisionSchema = z
  .object({
    id: uuidSchema,
    expectedVersion: z.number().int().nonnegative(),
    clientKey: z.string().min(8).max(200),
    action: z.enum(["confirm", "reject"]),
    expiresAt: isoDateTimeSchema.nullable().optional().default(null),
  })
  .strict();

export type MemoryCandidateDecision = z.infer<typeof memoryCandidateDecisionSchema>;
