import { describe, expect, it } from "vitest";
import { contentDeliveryHeaders, contentDeliveryReleaseKey } from "./content-delivery";
describe("content release request identity", () => {
  it("reuses a valid retry identity and rejects arbitrary help claims in its place", () => {
    const id = "10000000-0000-4000-8000-000000000001";
    expect(contentDeliveryReleaseKey(new Request("http://local.test", { headers: { "x-study-release-key": id } }))).toBe(id);
    expect(() => contentDeliveryReleaseKey(new Request("http://local.test", { headers: { "x-study-release-key": "language_only" } }))).toThrow();
    expect(contentDeliveryReleaseKey(new Request("http://local.test"))).toMatch(/^[\da-f-]{36}$/);
  });
  it("prevents content caching and exposes receipts without replacing legacy arrays", () => {
    expect(contentDeliveryHeaders([])).toEqual({ "Cache-Control": "private, no-store", "X-Study-Exposure-Receipts": "" });
  });
});
