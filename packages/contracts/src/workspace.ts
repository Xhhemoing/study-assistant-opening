import { z } from "zod";

/** Workspace-scoped stable identity (UUID string). */
export const workspaceIdSchema = z.string().uuid();

export const workspaceSchema = z.object({
  id: workspaceIdSchema,
  ownerUserId: z.string().uuid(),
  schemaVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type WorkspaceId = z.infer<typeof workspaceIdSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
