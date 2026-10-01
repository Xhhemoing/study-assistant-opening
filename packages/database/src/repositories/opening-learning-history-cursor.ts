import { z } from "zod";
import { learningError } from "./opening-learning-facts";

const cursorSchema = z.object({
  version: z.literal(1), workspaceId: z.string().uuid(), ownerUserId: z.string().uuid(), courseId: z.string().uuid(),
  requirement: z.union([z.object({ kind: z.literal("all") }).strict(),
    z.object({ kind: z.literal("key"), value: z.string().max(200).nullable() }).strict()]),
  snapshotRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  rootId: z.string().uuid(), occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  initialTotalCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  initialPrivacyEpoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type LearningHistoryCursor = z.infer<typeof cursorSchema>;

/** Ordinary bounded encoding, not a signature. Scope and persisted boundaries are revalidated by the reader. */
export function decodeLearningHistoryCursor(value: string): LearningHistoryCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new Error("invalid encoding");
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("noncanonical encoding");
    return cursorSchema.parse(JSON.parse(decoded.toString("utf8")));
  } catch {
    throw learningError("VALIDATION", "invalid learning history cursor");
  }
}
export function encodeLearningHistoryCursor(cursor: LearningHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
