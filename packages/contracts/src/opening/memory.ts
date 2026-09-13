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
