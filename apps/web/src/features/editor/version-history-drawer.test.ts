import { describe, expect, it } from "vitest";
import { sortRevisions, type EditorRevision } from "./version-history";

const revision = (revisionNumber: number): EditorRevision => ({
  revisionNumber,
  title: `v${revisionNumber}`,
  blocks: [],
});

describe("version history", () => {
  it("orders revisions newest first without mutating the API result", () => {
    const source = [revision(1), revision(3), revision(2)];

    expect(sortRevisions(source).map((item) => item.revisionNumber)).toEqual([3, 2, 1]);
    expect(source.map((item) => item.revisionNumber)).toEqual([1, 3, 2]);
  });
});
