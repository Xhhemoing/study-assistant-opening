import { z } from "zod";
import { learningError } from "./opening-learning-facts";
const summaryCursorSchema = z.object({
  version: z.literal(1), workspaceId: z.string().uuid(), ownerUserId: z.string().uuid(), courseId: z.string().uuid(),
  snapshotRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), privacyEpoch: z.number().int().min(0),
  policyVersion: z.string().min(1), evaluatedAt: z.string().datetime(), limit: z.number().int().min(1).max(50),
  after: z.object({ skillLabel: z.string(), requirementKey: z.string().nullable() }).nullable(),
}).strict();
export type LearningSummaryCursor = z.infer<typeof summaryCursorSchema>;
export function encodeLearningSummaryCursor(value: LearningSummaryCursor): string {
  return Buffer.from(JSON.stringify(summaryCursorSchema.parse(value))).toString("base64url");
}
export function decodeLearningSummaryCursor(value: string): LearningSummaryCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 4096) throw new Error("invalid encoding");
    return summaryCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch { throw learningError("VALIDATION", "invalid learning summary cursor"); }
}
