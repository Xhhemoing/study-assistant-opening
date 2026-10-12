/**
 * 经 (warp): the artifact envelope. Content and its revision live here;
 * view choices (text / static / interactive, scrub position) never do.
 */
import { z } from "zod";

export const ARTIFACT_SCHEMA_VERSION = "1" as const;
export const ARTIFACT_MAX_BLOCKS = 32;
/** Serialized params budget per block; guards persisted / model-produced JSON. */
export const BLOCK_PARAMS_MAX_BYTES = 64 * 1024;

const idSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);

/** `name@major`, e.g. `matrix-transform@1`. */
export const capabilityIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}@[1-9]\d{0,3}$/);

/** Opaque to the core; hosts resolve refs under their own permissions. */
export const sourceRefSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    locator: z.string().max(200).optional(),
  })
  .strict();

export const artifactBlockSchema = z
  .object({
    id: idSchema,
    capability: capabilityIdSchema,
    params: z.unknown(),
    /** Subset of the capability's declared actions this block may request. */
    allowedActions: z.array(z.string().min(1).max(80)).max(16).default([]),
    /** Interpretation limits shown next to the block (e.g. "动画不构成证明"). */
    limits: z.array(z.string().min(1).max(300)).max(8).default([]),
    sourceRefs: z.array(sourceRefSchema).max(32).default([]),
  })
  .strict();

export const artifactSchema = z
  .object({
    schemaVersion: z.literal(ARTIFACT_SCHEMA_VERSION),
    artifactId: idSchema,
    revision: z.number().int().positive(),
    title: z.string().min(1).max(200).optional(),
    provenance: z
      .object({
        origin: z.enum(["model", "rules", "user", "import"]),
        note: z.string().max(300).optional(),
      })
      .strict(),
    blocks: z.array(artifactBlockSchema).min(1).max(ARTIFACT_MAX_BLOCKS),
  })
  .strict()
  .superRefine((artifact, ctx) => {
    const seen = new Set<string>();
    artifact.blocks.forEach((block, index) => {
      if (seen.has(block.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate block id ${block.id}`, path: ["blocks", index, "id"] });
      }
      seen.add(block.id);
      if (serializedBytes(block.params) > BLOCK_PARAMS_MAX_BYTES) {
        ctx.addIssue({ code: "custom", message: "block params too large", path: ["blocks", index, "params"] });
      }
    });
  });

export type SourceRef = z.infer<typeof sourceRefSchema>;
export type ArtifactBlock = z.infer<typeof artifactBlockSchema>;
export type Artifact = z.infer<typeof artifactSchema>;

export type ArtifactParseResult =
  | { ok: true; artifact: Artifact }
  | { ok: false; reason: "unknown_schema_version" | "invalid_envelope"; issues: string[] };

function serializedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  } catch {
    // Cyclic / BigInt values cannot be persisted either; treat as over budget.
    return Number.POSITIVE_INFINITY;
  }
}

/** Envelope-level validation for untrusted input. Block params are checked per capability in `decideBlock`. */
export function parseArtifact(input: unknown): ArtifactParseResult {
  if (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    (input as { schemaVersion: unknown }).schemaVersion !== ARTIFACT_SCHEMA_VERSION
  ) {
    return { ok: false, reason: "unknown_schema_version", issues: [] };
  }
  const parsed = artifactSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_envelope",
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }
  return { ok: true, artifact: parsed.data };
}

export class RevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(`artifact revision changed: expected ${expectedRevision}, current ${currentRevision}`);
    this.name = "RevisionConflictError";
  }
}

/**
 * The only way content changes. Optimistic: callers state the revision they edited,
 * so a stale edit never silently overwrites a newer one.
 */
export function reviseArtifact(
  current: Artifact,
  expectedRevision: number,
  edit: (blocks: ArtifactBlock[]) => ArtifactBlock[],
): Artifact {
  if (expectedRevision !== current.revision) {
    throw new RevisionConflictError(expectedRevision, current.revision);
  }
  const next = artifactSchema.parse({
    ...current,
    revision: current.revision + 1,
    blocks: edit(structuredClone(current.blocks)),
  });
  return next;
}

/** Late renders / stream frames produced for an older revision must not replace newer content. */
export function isCurrentFrame(currentRevision: number, producedForRevision: number): boolean {
  return currentRevision === producedForRevision;
}
