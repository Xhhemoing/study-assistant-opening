import { z } from "zod";
import { workspaceIdSchema } from "./workspace";

/**
 * Unified asset types shared across learn / explore / library.
 * Course membership is relational and must not appear on identity.
 */
export const assetTypeSchema = z.enum([
  "source",
  "document",
  "block",
  "card",
  "practice-item",
  "artifact",
]);

/**
 * Lifecycle for exploration drafts through long-lived formal assets.
 * AI may create/suggest scratch|candidate only; formal states need human paths.
 */
export const assetLifecycleSchema = z.enum([
  "scratch",
  "candidate",
  "confirmed",
  "published",
  "archived",
  "discarded",
]);

export type AssetType = z.infer<typeof assetTypeSchema>;
export type AssetLifecycle = z.infer<typeof assetLifecycleSchema>;

/** Identity envelope — no course IDs. */
export const assetSchema = z.object({
  id: z.string().uuid(),
  workspaceId: workspaceIdSchema,
  type: assetTypeSchema,
  lifecycle: assetLifecycleSchema,
  schemaVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Asset = z.infer<typeof assetSchema>;

/**
 * Allowed directed transitions.
 * - discarded is terminal
 * - archived may reactivate to confirmed (not straight to published)
 * - published may unpublish to confirmed or archive
 * - formal states cannot demote to scratch/candidate
 */
const ALLOWED: Readonly<Record<AssetLifecycle, readonly AssetLifecycle[]>> = {
  scratch: ["scratch", "candidate", "confirmed", "archived", "discarded"],
  candidate: [
    "candidate",
    "scratch",
    "confirmed",
    "archived",
    "discarded",
  ],
  confirmed: ["confirmed", "published", "archived", "discarded"],
  published: ["published", "confirmed", "archived"],
  archived: ["archived", "confirmed", "discarded"],
  discarded: ["discarded"],
};

export class LifecycleTransitionError extends Error {
  readonly from: AssetLifecycle;
  readonly to: AssetLifecycle;

  constructor(from: AssetLifecycle, to: AssetLifecycle) {
    super(`Invalid asset lifecycle transition: ${from} → ${to}`);
    this.name = "LifecycleTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransitionLifecycle(
  from: AssetLifecycle,
  to: AssetLifecycle,
): boolean {
  return ALLOWED[from].includes(to);
}

export function assertLifecycleTransition(
  from: AssetLifecycle,
  to: AssetLifecycle,
): void {
  if (!canTransitionLifecycle(from, to)) {
    throw new LifecycleTransitionError(from, to);
  }
}
