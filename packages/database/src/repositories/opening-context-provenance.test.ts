import { describe, expect, it } from "vitest";
import { mergeContextSourceRefs, parseContextSourceRefs } from "./opening-context-provenance";

const id = "a0b0c0d0-1111-4222-8333-000000000000";
describe("material provenance JSON", () => {
  it("distinguishes unknown and malformed lineage from known source-free context", () => {
    expect(parseContextSourceRefs(null)).toBeNull();
    expect(parseContextSourceRefs({})).toBeNull();
    expect(parseContextSourceRefs([])).toEqual([]);
    for (const value of [null, {}, { sourceId: id }, { sourceId: id, sourceVersion: "0" },
      { sourceId: id, sourceVersion: -1 }, { sourceId: id, sourceVersion: 0.5 },
      { sourceId: id, sourceVersion: 9007199254740992 }, { sourceId: "bad", sourceVersion: 0 }]) {
      expect(parseContextSourceRefs([value])).toBeNull();
    }
  });
  it("keeps every consumed source version while deduplicating equivalent UUID spellings", () => {
    expect(parseContextSourceRefs([{ sourceId: id.toUpperCase(), sourceVersion: 0 },
      { sourceId: id, sourceVersion: 0 }, { sourceId: id, sourceVersion: 1 }])).toEqual([
      { sourceId: id, sourceVersion: 0 }, { sourceId: id, sourceVersion: 1 },
    ]);
    expect(mergeContextSourceRefs([{ sourceId: id, sourceVersion: 0 }], [{ sourceId: id, sourceVersion: 1 }])).toHaveLength(2);
  });
  it("preserves memoryOnly only when every occurrence of that sourceId is memoryOnly and rejects malformed memoryOnly", () => {
    const other = "b0b0c0d0-1111-4222-8333-000000000000";
    expect(parseContextSourceRefs([{ sourceId: id, sourceVersion: 0, memoryOnly: "true" }])).toBeNull();
    expect(parseContextSourceRefs([{ sourceId: id, sourceVersion: 0, memoryOnly: true }])).toEqual([
      { sourceId: id, sourceVersion: 0, memoryOnly: true },
    ]);
    // Any non-memory occurrence of the same sourceId (even across distinct versions) strips memoryOnly.
    expect(mergeContextSourceRefs(
      [{ sourceId: id, sourceVersion: 0 }, { sourceId: other, sourceVersion: 0, memoryOnly: true }],
      [{ sourceId: id, sourceVersion: 1, memoryOnly: true }, { sourceId: other, sourceVersion: 1, memoryOnly: true }],
    )).toEqual([
      { sourceId: id, sourceVersion: 0 },
      { sourceId: other, sourceVersion: 0, memoryOnly: true },
      { sourceId: id, sourceVersion: 1 },
      { sourceId: other, sourceVersion: 1, memoryOnly: true },
    ]);
  });
});
