import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

export const actionCandidateSchema = z.object({ id: uuidSchema, dedupeKey: z.string().min(1).max(240), title: z.string().min(1).max(500), minutes: z.number().int().positive().max(1440), dueAt: isoDateTimeSchema.nullable(), priority: z.number().finite(), sourceIds: z.array(uuidSchema), status: z.enum(["pending", "accepted", "rejected", "superseded"]), needsConfirmation: z.boolean() }).strict();
export const actionDigestSchema = z.object({ primary: z.array(actionCandidateSchema).max(3), pendingConfirmationCount: z.number().int().nonnegative() }).strict();
export type ActionCandidate = z.infer<typeof actionCandidateSchema>;
export type ActionDigest = z.infer<typeof actionDigestSchema>;
