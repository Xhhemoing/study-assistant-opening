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

  it("returns page 1 bytes for image sources", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const sql = vi.fn(async () => [{ mime: "image/png", bytes: png.byteLength }]);
    const storage = {
      finalKey: vi.fn(() => "opening/sources/x/v0"),
      presignGet: vi.fn(async () => `data:image/png;base64,${png.toString("base64")}`),
    } as never;
    const result = await createSourcePageImages(sql as never, storage)({ workspaceId: "w", ownerUserId: "u" }, {
      sourceIds: [id], sourceVersions: { [id]: 0 }, physicalPage: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sourceId: id, physicalPage: 1, mediaType: "image/png" });
    expect(result[0]!.data.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("skips image sources for pages other than 1", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const sql = vi.fn(async () => [{ mime: "image/jpeg", bytes: 10 }]);
    const storage = { finalKey: vi.fn(), presignGet: vi.fn() } as never;
    const result = await createSourcePageImages(sql as never, storage)({ workspaceId: "w", ownerUserId: "u" }, {
      sourceIds: [id], sourceVersions: { [id]: 0 }, physicalPage: 2,
    });
    expect(result).toEqual([]);
    expect(storage.presignGet).not.toHaveBeenCalled();
  });
