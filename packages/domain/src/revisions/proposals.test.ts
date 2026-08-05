import { describe, expect, it } from "vitest";
import {
  diffRevisionBlocks,
  assertNonEmptyRevisionBlocks,
  preserveBothBlocks,
  selectProposalBlocks,
} from "./proposals";
import type { RevisionProposalBlock } from "@aistudy/contracts";

const block = (id: string, text: string, position: number): RevisionProposalBlock => ({
  id,
  type: "paragraph",
  position,
  content: { text },
});

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";

 describe("revision proposal domain helpers", () => {
  it("classifies blocks and keeps deterministic base/proposed ordering", () => {
    const entries = diffRevisionBlocks(
      [block(a, "same", 0), block(b, "before", 1)],
      [block(a, "same", 0), block(b, "after", 1), block(c, "new", 2)],
    );

    expect(entries.map((entry) => [entry.blockId, entry.kind])).toEqual([
      [a, "unchanged"],
      [b, "changed"],
      [c, "added"],
    ]);
    expect(diffRevisionBlocks([block(a, "gone", 0)], []).map((entry) => entry.kind)).toEqual(["removed"]);
  });

  it("rejects duplicate block IDs", () => {
    expect(() => diffRevisionBlocks([block(a, "one", 0), block(a, "two", 1)], [])).toThrow(/Duplicate block id/);
    expect(() => selectProposalBlocks([], [block(a, "one", 0), block(a, "two", 1)], [a], [])).toThrow(/Duplicate block id/);
  });

  it("replaces only explicitly selected blocks and appends selected additions", () => {
    const result = selectProposalBlocks(
      [block(a, "current a", 0), block(b, "current b", 1)],
      [block(a, "proposed a", 0), block(c, "proposed c", 1)],
      [a, c],
      diffRevisionBlocks([block(a, "current a", 0), block(b, "current b", 1)], [block(a, "proposed a", 0), block(c, "proposed c", 1)]),
    );

    expect(result.map((item) => item.id)).toEqual([a, b, c]);
    expect(result.map((item) => item.content.text)).toEqual(["proposed a", "current b", "proposed c"]);
    expect(result.map((item) => item.position)).toEqual([0, 1, 2]);
  });

  it("preserves current blocks and gives colliding proposal blocks new stable IDs", () => {
    const result = preserveBothBlocks(
      [block(a, "current", 0)],
      [block(a, "proposal", 0), block(b, "new proposal", 1)],
      [a, b],
      diffRevisionBlocks([block(a, "current", 0)], [block(a, "proposal", 0), block(b, "new proposal", 1)]),
    );

    expect(result).toHaveLength(3);
    expect(new Set(result.map((item) => item.id)).size).toBe(3);
    expect(result[0]).toMatchObject({ id: a, content: { text: "current" } });
    expect(result.slice(1).map((item) => item.content.text)).toEqual(["proposal", "new proposal"]);
    expect(result.map((item) => item.position)).toEqual([0, 1, 2]);
  });

  it("rejects partial acceptance that would remove the document's only block", () => {
    const result = selectProposalBlocks(
      [block(a, "remove", 0)],
      [block(c, "replacement", 0)],
      [a],
      diffRevisionBlocks([block(a, "remove", 0)], [block(c, "replacement", 0)]),
    );

    expect(() => assertNonEmptyRevisionBlocks(result)).toThrow("Document requires at least one block");
  });

  it("removes selected base blocks while keeping unselected blocks during partial acceptance", () => {
    const result = selectProposalBlocks(
      [block(a, "remove", 0), block(b, "keep", 1)],
      [block(b, "keep", 0), block(c, "add", 1)],
      [a, c],
      diffRevisionBlocks([block(a, "remove", 0), block(b, "keep", 1)], [block(b, "keep", 0), block(c, "add", 1)]),
    );

    expect(result.map((item) => item.id)).toEqual([b, c]);
    expect(result.map((item) => item.content.text)).toEqual(["keep", "add"]);
    expect(result.map((item) => item.position)).toEqual([0, 1]);
  });

  it("ignores selected removed blocks when preserving both", () => {
    const result = preserveBothBlocks(
      [block(a, "current", 0), block(b, "keep", 1)],
      [block(b, "keep", 0)],
      [a],
      diffRevisionBlocks([block(a, "current", 0), block(b, "keep", 1)], [block(b, "keep", 0)]),
    );

    expect(result.map((item) => item.id)).toEqual([a, b]);
  });
});
