import { afterEach, describe, expect, it, vi } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn(() => ({ sql: {} })) }));
vi.mock("server-only", () => ({}));
vi.mock("@aistudy/config", () => ({ loadEnv: () => ({ databaseUrl: "local-test", authSecret: "test", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "session" }) }));
vi.mock("../features/auth/service", () => ({ createAuthRuntime: create }));

afterEach(() => {
  delete (globalThis as typeof globalThis & { aistudyAuthRuntime?: unknown }).aistudyAuthRuntime;
  vi.unstubAllEnvs();
  vi.resetModules();
  create.mockClear();
});

describe("development database runtime lifetime", () => {
  it("reuses one pool across development module reloads", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const first = (await import("./runtime")).getAuthRuntime();
    vi.resetModules();
    const restored = (await import("./runtime")).getAuthRuntime();
    expect(restored).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps test runtimes isolated across module reloads", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const first = (await import("./runtime")).getAuthRuntime();
    vi.resetModules();
    const restored = (await import("./runtime")).getAuthRuntime();
    expect(restored).not.toBe(first);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
