import { z } from "zod";
import type { CourseRequirementProgress, TeachingBlockRef } from "@aistudy/contracts";

type Coverage = NonNullable<CourseRequirementProgress["citationCoverage"]>;
type Counts = Coverage["byRole"]["teach"];
const roles = ["teach", "prompt", "example", "answer_key"] as const;
const emptyCounts = (): Counts => ({ total: 0, bound: 0, missing: 0, mismatch: 0, unknown: 0 });
const bindingSchema = z.object({
  blockId: z.string().uuid(), role: z.enum(roles), status: z.enum(["bound", "missing", "mismatch"]),
  refs: z.array(z.object({ sourceId: z.string().uuid(), sourceVersion: z.number().int().nonnegative(),
    chunkId: z.string().uuid(), page: z.number().int().positive().nullable() }).strict()),
  factualSupport: z.literal("unverified"),
}).strict().refine(binding => binding.status === "bound" ? binding.refs.length > 0
  : binding.status !== "missing" || binding.refs.length === 0);

type PersistedBlock = { id: string; type: string; content: Record<string, unknown> };

/**
 * Count the FULL current, persisted revision population, including rejected
 * revisions and hidden answer keys. The caller must first authorize scope,
 * current revision and live sources (privacy, retraction and private access).
 * Not for provider output or client-init's redacted answer bodies. This only
 * projects server-written location bindings; it cannot verify factual support
 * or replace the reader's authorization/currentness checks.
 */
export function projectCourseCitationCoverage(input: {
  blockOrder: readonly TeachingBlockRef[];
  blocks: readonly PersistedBlock[];
}): Coverage {
  const coverage: Coverage = { ...emptyCounts(), byRole: {
    teach: emptyCounts(), prompt: emptyCounts(), example: emptyCounts(), answer_key: emptyCounts(),
  }, factualSupport: "unverified" };
  const blocks = new Map(input.blocks.map(block => [block.id, block]));
  for (const ref of input.blockOrder) {
    if (ref.role === "meta") continue;
    const counts = coverage.byRole[ref.role];
    const block = blocks.get(ref.blockId);
    // Persisted JSON is a trust boundary: never trust a legacy/model coverage
    // verdict, a citedChunkIds list, or an identity copied from another block.
    const parsed = bindingSchema.safeParse(block?.content.citationBinding);
    const status = block?.type === ref.blockType && parsed.success
      && parsed.data.blockId === ref.blockId && parsed.data.role === ref.role
      ? parsed.data.status : "unknown";
    counts.total++; counts[status]++;
    coverage.total++; coverage[status]++;
  }
  return coverage;
}
