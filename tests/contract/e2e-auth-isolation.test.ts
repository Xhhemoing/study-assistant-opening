import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reset } = vi.hoisted(() => ({ reset: vi.fn() }));
vi.mock("@playwright/test", () => ({
  test: { extend: (definitions: unknown) => definitions },
  expect: undefined,
}));
vi.mock("../support/auth-rate-limit-state", () => ({ resetTestAuthRateLimits: reset }));
import { test } from "../e2e/fixtures";

type Isolation = (fixtures: { baseURL?: string }, use: () => Promise<void>) => Promise<void>;
const [isolate, options] = (test as unknown as { authRateLimitIsolation: [Isolation, { auto: boolean }] }).authRateLimitIsolation;

beforeEach(() => {
  reset.mockReset();
  vi.stubEnv("E2E_DATABASE_URL", "postgres://127.0.0.1/aistudy_e2e");
  vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379/5");
  vi.stubEnv("AUTH_SECRET", "fixture-test-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("shared E2E authentication fixture", () => {
  it("automatically awaits counter isolation before exposing a test case", async () => {
    let finishReset!: () => void;
    reset.mockImplementation(() => new Promise<void>((resolve) => { finishReset = resolve; }));
    const use = vi.fn().mockResolvedValue(undefined);
    const running = isolate({ baseURL: "http://127.0.0.1:3000" }, use);
    expect(options.auto).toBe(true);
    expect(use).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledWith({ databaseUrl: "postgres://127.0.0.1/aistudy_e2e", redisUrl: "redis://127.0.0.1:6379/5", authSecret: "fixture-test-secret" });
    finishReset();
    await running;
    expect(use).toHaveBeenCalledOnce();
  });

  it("stops the case if isolation is refused or unavailable", async () => {
    reset.mockRejectedValueOnce(new Error("isolated database required"));
    const use = vi.fn();
    await expect(isolate({}, use)).rejects.toThrow("isolated database required");
    expect(use).not.toHaveBeenCalled();
  });
});
