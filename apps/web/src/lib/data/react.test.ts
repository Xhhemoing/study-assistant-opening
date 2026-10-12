import { afterEach, describe, expect, it, vi } from "vitest";
import { allowsDemoStudyData } from "../../features/opening/access-policy";
import { createLegacyStudyProvider, fetchCurrentUserId } from "./react";

describe("react data identity loading", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the current identity again after the user changes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: "user-a" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: "user-b" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCurrentUserId()).resolves.toBe("user-a");
    await expect(fetchCurrentUserId()).resolves.toBe("user-b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache an authentication failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: "recovered-user" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCurrentUserId()).resolves.toBeNull();
    await expect(fetchCurrentUserId()).resolves.toBe("recovered-user");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("createLegacyStudyProvider production gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to construct mock provider in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(allowsDemoStudyData()).toBe(false);
    expect(() => createLegacyStudyProvider("user-1")).toThrow(/unavailable in production/);
  });

  it("still allows demo construction outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(allowsDemoStudyData()).toBe(true);
    // Construction touches browserStorage; in node it uses in-memory fallback via mock storage.
    expect(() => createLegacyStudyProvider("user-demo")).not.toThrow();
  });
});
