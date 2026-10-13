import { afterEach, describe, expect, it, vi } from "vitest";
import { allowsDemoStudyData } from "../../features/opening/access-policy";
import { createLegacyStudyProvider } from "./demo-study-provider";
import { fetchCurrentUserId } from "./react";

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

describe("demo study provider production gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("policy refuses demo study data in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(allowsDemoStudyData()).toBe(false);
  });

  it("still allows demo construction outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(allowsDemoStudyData()).toBe(true);
    expect(() => createLegacyStudyProvider("user-demo")).not.toThrow();
  });
});
