import { describe, expect, it } from "vitest";
import type { TeachingBlockRef } from "@aistudy/contracts";
import { projectCourseCitationCoverage } from "./course-citation-coverage";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = { sourceId: id(90), sourceVersion: 0, chunkId: id(91), page: 1 };
function fixture(role: TeachingBlockRef["role"], n: number, status = "bound") {
  const ref: TeachingBlockRef = { blockId: id(n), blockType: role, role, position: n };
  const block = { id: id(n), type: role, content: { text: `private-body-${n}`, answer: "private-key",
    citationBinding: { blockId: id(n), role, status, refs: status === "bound" ? [source] : [], factualSupport: "unverified" } } };
  return { ref, block };
}
const count = (total: number, bound = 0, missing = 0, mismatch = 0, unknown = 0) => ({ total, bound, missing, mismatch, unknown });

describe("course citation projection", () => {
  it("counts every required role across the full persisted population without capping prompts or keys", () => {
    const rows = [fixture("teach", 1), fixture("teach", 2, "missing"), fixture("example", 3, "mismatch"),
      ...Array.from({ length: 5 }, (_, n) => [fixture("prompt", 4 + n * 2, "missing"), fixture("answer_key", 5 + n * 2)]).flat(),
      fixture("meta", 20)];
    const result = projectCourseCitationCoverage({ blockOrder: rows.map(row => row.ref), blocks: rows.map(row => row.block).reverse() });
    expect(result).toEqual({ ...count(13, 6, 6, 1), factualSupport: "unverified", byRole: {
      teach: count(2, 1, 1), example: count(1, 0, 0, 1), prompt: count(5, 0, 5), answer_key: count(5, 5),
    } });
    const serialized = JSON.stringify(result);
    for (const secret of ["private-body", "private-key", id(5), id(90), id(91), "citationBinding", "refs"])
      expect(serialized).not.toContain(secret);
  });
  it("keeps absent bodies, legacy bindings and model self-reports in the denominator as unknown", () => {
    const rows = Array.from({ length: 4 }, (_, n) => fixture("teach", n + 1));
    const blocks = [
      { ...rows[1]!.block, content: { text: "legacy", citedChunkIds: [id(91)] } },
      { ...rows[2]!.block, content: { coverage: "verified", factualSupport: "verified", refs: [source] } },
      { ...rows[3]!.block, content: { citationBinding: null } },
      fixture("teach", 99).block, // Not in this current spec.
    ];
    expect(projectCourseCitationCoverage({ blockOrder: rows.map(row => row.ref), blocks })).toMatchObject(count(4, 0, 0, 0, 4));
  });
  it("treats invalid, stale-identity or self-verified bindings as unknown, not missing or bound", () => {
    const row = fixture("answer_key", 1);
    const binding = row.block.content.citationBinding;
    for (const invalid of [
      { ...binding, blockId: id(2) }, { ...binding, role: "prompt" }, { ...binding, status: "verified" },
      { ...binding, factualSupport: "verified" }, { ...binding, refs: [] },
      { ...binding, refs: [{ ...source, sourceVersion: -1 }] },
      { ...binding, refs: [{ ...source, chunkId: "not-an-id" }] },
      { ...binding, refs: [{ ...source, page: 0 }] },
      { ...binding, status: "missing" }, { ...binding, answer: "private" },
    ]) {
      const result = projectCourseCitationCoverage({ blockOrder: [row.ref], blocks: [{ ...row.block, content: { citationBinding: invalid } }] });
      expect(result).toMatchObject({ ...count(1, 0, 0, 0, 1), byRole: { answer_key: count(1, 0, 0, 0, 1) } });
    }
    expect(projectCourseCitationCoverage({ blockOrder: [row.ref], blocks: [{ ...row.block, type: "prompt" }] }))
      .toMatchObject(count(1, 0, 0, 0, 1));
  });
  it("preserves mismatch even when some locations bound, and distinguishes empty populations", () => {
    const row = fixture("example", 1, "mismatch");
    row.block.content.citationBinding.refs = [source];
    expect(projectCourseCitationCoverage({ blockOrder: [row.ref], blocks: [row.block] })).toMatchObject(count(1, 0, 0, 1));
    expect(projectCourseCitationCoverage({ blockOrder: [], blocks: [] })).toEqual({ ...count(0), factualSupport: "unverified",
      byRole: { teach: count(0), prompt: count(0), example: count(0), answer_key: count(0) } });
  });
});
