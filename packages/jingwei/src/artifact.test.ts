import { describe, expect, it } from "vitest";
import {
  BLOCK_PARAMS_MAX_BYTES,
  RevisionConflictError,
  isCurrentFrame,
  parseArtifact,
  reviseArtifact,
  type Artifact,
} from "./artifact";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    schemaVersion: "1",
    artifactId: "explain-linear-map",
    revision: 1,
    provenance: { origin: "rules" },
    blocks: [
      { id: "b1", capability: "comparison-bars@1", params: { bars: [] }, allowedActions: [], limits: [], sourceRefs: [] },
    ],
    ...overrides,
  };
}

describe("parseArtifact", () => {
  it("accepts a minimal envelope and fills block defaults", () => {
    const result = parseArtifact({
      schemaVersion: "1",
      artifactId: "a1",
      revision: 1,
      provenance: { origin: "model" },
      blocks: [{ id: "b1", capability: "flow-diagram@1", params: {} }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.artifact.blocks[0]).toMatchObject({ allowedActions: [], limits: [], sourceRefs: [] });
  });

  it("reports unknown schema versions separately so hosts can say so", () => {
    expect(parseArtifact({ ...artifact(), schemaVersion: "2" })).toEqual({
      ok: false,
      reason: "unknown_schema_version",
      issues: [],
    });
  });

  it("rejects duplicate block ids, bad capability ids and unknown keys", () => {
    const dup = artifact({ blocks: [...artifact().blocks, ...artifact().blocks] });
    expect(parseArtifact(dup)).toMatchObject({ ok: false, reason: "invalid_envelope" });
    const badId = artifact({ blocks: [{ ...artifact().blocks[0]!, capability: "Comparison" }] });
    expect(parseArtifact(badId)).toMatchObject({ ok: false, reason: "invalid_envelope" });
    expect(parseArtifact({ ...artifact(), html: "<b>x</b>" })).toMatchObject({ ok: false, reason: "invalid_envelope" });
    expect(parseArtifact(null)).toMatchObject({ ok: false, reason: "invalid_envelope" });
  });

  it("rejects oversized block params", () => {
    const big = artifact({
      blocks: [{ ...artifact().blocks[0]!, params: { text: "x".repeat(BLOCK_PARAMS_MAX_BYTES + 1) } }],
    });
    const result = parseArtifact(big);
    expect(result).toMatchObject({ ok: false, reason: "invalid_envelope" });
    if (!result.ok) expect(result.issues.join()).toContain("too large");
  });
});

describe("reviseArtifact", () => {
  it("bumps the revision without mutating the original", () => {
    const current = artifact();
    const next = reviseArtifact(current, 1, (blocks) =>
      blocks.map((block) => ({ ...block, params: { bars: [{ label: "阅读", value: 25 }] } })),
    );
    expect(next.revision).toBe(2);
    expect(next.blocks[0]!.params).toEqual({ bars: [{ label: "阅读", value: 25 }] });
    expect(current.revision).toBe(1);
    expect(current.blocks[0]!.params).toEqual({ bars: [] });
  });

  it("refuses stale edits instead of overwriting newer content", () => {
    const current = artifact({ revision: 3 });
    expect(() => reviseArtifact(current, 2, (blocks) => blocks)).toThrow(RevisionConflictError);
  });

  it("re-validates the edited envelope", () => {
    expect(() => reviseArtifact(artifact(), 1, () => [])).toThrow();
  });
});

describe("isCurrentFrame", () => {
  it("only accepts frames produced for the current revision", () => {
    expect(isCurrentFrame(4, 4)).toBe(true);
    expect(isCurrentFrame(4, 3)).toBe(false);
  });
});
