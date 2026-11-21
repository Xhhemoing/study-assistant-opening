import { describe, expect, it } from "vitest";
import { mergeContextSourceRefs, parseContextMemoryDependencyIds, parseContextSourceRefs } from "./opening-context-provenance";

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
  it("parses exact memoryDependencyIds metadata separately from document source refs and rejects malformed metadata", () => {
    const m1 = "c0b0c0d0-1111-4222-8333-000000000001";
    const m2 = "c0b0c0d0-1111-4222-8333-000000000002";
    const mixed = [{ sourceId: id, sourceVersion: 0, memoryOnly: true }, { memoryDependencyIds: [m2.toUpperCase(), m1, m2] }];
    expect(parseContextSourceRefs(mixed)).toEqual([{ sourceId: id, sourceVersion: 0, memoryOnly: true }]);
    expect(parseContextMemoryDependencyIds(mixed)).toEqual([m1, m2]);
    // Documentless global-memory turn has [] document refs and exact memoryDependencyIds.
    expect(parseContextSourceRefs([{ memoryDependencyIds: [m1] }])).toEqual([]);
    expect(parseContextMemoryDependencyIds([{ memoryDependencyIds: [m1] }])).toEqual([m1]);
    // Malformed metadata fails closed in both parsers.
    for (const bad of [
      [{ memoryDependencyIds: [] }],
      [{ memoryDependencyIds: ["not-a-uuid"] }],
      [{ memoryDependencyIds: [m1], extra: true }],
    ]) {
      expect(parseContextSourceRefs(bad)).toBeNull();
      expect(parseContextMemoryDependencyIds(bad)).toBeNull();
    }
  });
});
