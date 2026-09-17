import { describe, expect, it } from "vitest";
import type { SourceChunk } from "@aistudy/contracts";
import { resolveCitations } from "./citations";
const base = (id: string, values: Partial<SourceChunk> = {}): SourceChunk => ({ id, sourceId: "00000000-0000-0000-0000-000000000001", sourceVersion: 2, page: 3, slideLabel: null, startMs: null, endMs: null, text: "text", imageObjectKey: null, ...values });
describe("opening citations", () => {
  it("rejects fabricated and unknown IDs", () => { expect(() => resolveCitations(["invented"], [])).toThrowError(new RangeError("unknown citation: invented")); expect(resolveCitations([], [])).toEqual([]); expect(() => resolveCitations(["ok", "missing"], [base("ok")])).toThrow(/unknown citation: missing/); });
  it("preserves order and formats labels", () => {
    expect(resolveCitations(["b", "a"], [base("a"), base("b", { page: 4, startMs: 65000 })])).toEqual([expect.objectContaining({ chunkId: "b", label: "source 00000000-0000-0000-0000-000000000001 v2 page 4 at 1:05" }), expect.objectContaining({ chunkId: "a" })]);
    expect(resolveCitations(["slide"], [base("slide", { page: null, slideLabel: "A-1" })])[0].label).toContain("slide A-1");
  });
});
