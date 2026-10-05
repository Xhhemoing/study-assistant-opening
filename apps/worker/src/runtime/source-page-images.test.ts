import { describe, expect, it, vi } from "vitest";
import { createSourcePageImages } from "./source-page-images";

describe("source page image authorization", () => {
  it("skips selected non-PDF sources that do not contain the requested page", async () => {
    const sql = vi.fn(async () => [{ mime: "text/plain" }]);
    const storage = { finalKey: vi.fn(), presignGet: vi.fn() } as never;
    const result = await createSourcePageImages(sql as never, storage)({ workspaceId: "w", ownerUserId: "u" }, {
      sourceIds: ["11111111-1111-4111-8111-111111111111"], sourceVersions: { "11111111-1111-4111-8111-111111111111": 0 }, physicalPage: 2,
    });
    expect(result).toEqual([]);
    expect(storage.presignGet).not.toHaveBeenCalled();
  });
});
