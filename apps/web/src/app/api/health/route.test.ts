import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ loadEnv: vi.fn(), checkDatabase: vi.fn(), checkRedis: vi.fn(), checkStorage: vi.fn() }));
vi.mock("@aistudy/config", () => ({ loadEnv: mocks.loadEnv }));
vi.mock("../../../server/dependency-checks", () => mocks);
import { GET } from "./route";
beforeEach(() => {
  vi.stubEnv("AISTUDY_COMMIT", "189546c71095820f550bff754836f36e7fa17933");
  vi.stubEnv("AISTUDY_BUILT_AT", "2026-10-25T20:00:00.000Z");
  vi.resetAllMocks();
  mocks.loadEnv.mockReturnValue({ databaseUrl: "db", redisUrl: "redis", s3: {} });
  mocks.checkDatabase.mockResolvedValue({ status: "up", latencyMs: 1 });
  mocks.checkRedis.mockResolvedValue({ status: "up" });
  mocks.checkStorage.mockResolvedValue({ status: "up" });
});
it("keeps readiness success compatible with release checks without exposing dependencies", async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", commit: "189546c7", builtAt: "2026-10-25T20:00:00.000Z" });
  expect(mocks.checkDatabase).toHaveBeenCalledWith("db");
  expect(mocks.checkRedis).toHaveBeenCalledWith("redis");
  expect(mocks.checkStorage).toHaveBeenCalledWith({});
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
it("still fails readiness when any dependency is unavailable", async () => {
  mocks.checkStorage.mockResolvedValue({ status: "down", errorCode: "unreachable" });
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: "degraded", commit: "189546c7", builtAt: "2026-10-25T20:00:00.000Z" });
});
it("does not expose configuration failure details", async () => {
  mocks.loadEnv.mockImplementation(() => { throw new Error("secret configuration"); });
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: "down", commit: "189546c7", builtAt: "2026-10-25T20:00:00.000Z" });
  expect(mocks.checkDatabase).not.toHaveBeenCalled();
});

afterEach(() => vi.unstubAllEnvs());
