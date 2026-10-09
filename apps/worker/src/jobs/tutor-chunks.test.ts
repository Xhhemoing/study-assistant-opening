import { describe, expect, it } from "vitest";
import type { SourceChunk } from "@aistudy/contracts";
import { chunksAtSnapshots } from "./tutor-chunks";
const scope = { workspaceId: "w", ownerUserId: "o" };
const chunk = (text: string): SourceChunk => ({ id: "c", sourceId: "s", sourceVersion: 1, page: 1, text, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null });
describe("version-pinned tutor text", () => {
  it("refuses whitespace-only history instead of sending an empty source to a model", async () => {
    await expect(chunksAtSnapshots({ listChunksAtVersion: async () => [chunk(" \n\t")] }, scope, ["s"], { s: 1 })).rejects.toThrow("unavailable");
  });
  it("filters empty physical pages without changing source snapshot or page identity", async () => {
    expect(await chunksAtSnapshots({ listChunksAtVersion: async () => [chunk(""), { ...chunk("readable"), page: 2 }] }, scope, ["s"], { s: 1 })).toEqual([{ ...chunk("readable"), page: 2 }]);
  });
});
  it("keeps empty-text chunks that carry an image object key", async () => {
    const imageChunk = { ...chunk(""), imageObjectKey: "sources/photo.png" };
    expect(await chunksAtSnapshots({ listChunksAtVersion: async () => [imageChunk] }, scope, ["s"], { s: 1 })).toEqual([imageChunk]);
  });
