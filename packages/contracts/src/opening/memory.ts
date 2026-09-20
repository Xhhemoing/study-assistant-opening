import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

export const memoryItemSchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    /** Per-course scope — null means workspace-level; never silently global-bleed. */
    courseId: uuidSchema.nullable(),
    kind: z.enum(["confirmed", "candidate", "temporary"]),
    text: z.string().min(1).max(4000),
    sourceTurnIds: z.array(uuidSchema).max(32),
    version: z.number().int().nonnegative(),
    expiresAt: isoDateTimeSchema.nullable(),
    status: z.enum(["active", "rejected", "deleted"]),
    /** When the card was created (why/when surface). */
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "temporary" && value.expiresAt === null) {
      ctx.addIssue({
        code: "custom",
        message: "temporary memory requires expiresAt",
        path: ["expiresAt"],
      });
    }
  });

export const memoryDecisionSchema = z
  .object({
    id: uuidSchema,
    expectedVersion: z.number().int().nonnegative(),
    action: z.enum(["confirm", "reject", "delete"]),
    clientKey: z.string().min(8).max(200),
  })
  .strict();

export type MemoryItem = z.infer<typeof memoryItemSchema>;
export type MemoryDecision = z.infer<typeof memoryDecisionSchema>;

/** Effective scope derived from courseId — not a wire field (RU-06 continuity). */
export type MemoryEffectiveScope = "course" | "workspace";

/** courseId non-null → course; else workspace. Derive at T02/M01; do not add wire field. */
export function memoryEffectiveScope(item: {
  courseId: string | null;
}): MemoryEffectiveScope {
  return item.courseId != null ? "course" : "workspace";
}

/**
 * Workspace items (null courseId) visible in every course view; course items only
 * when activeCourseId matches. No cross-course load (RU-06).
 */
export function memoryVisibleInCourseScope(
  itemCourseId: string | null,
  activeCourseId: string | null,
): boolean {
  if (itemCourseId == null) return true;
  return activeCourseId != null && itemCourseId === activeCourseId;
}
