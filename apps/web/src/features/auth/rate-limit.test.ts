import { describe, expect, it, vi } from "vitest";
import { createAuthRateLimiter, trustedClientIp } from "./rate-limit";

const request = (headers: HeadersInit = {}) => new Request("http://localhost/api/auth/login", { headers });

describe("trusted auth client address", () => {
  it("ignores forwarding headers unless an administrator opts in", () => {
    expect(trustedClientIp(request({ "x-real-ip": "192.0.2.1" }))).toBeNull();
    expect(trustedClientIp(request({ "x-real-ip": "192.0.2.1" }), "x-real-ip")).toBe("192.0.2.1");
    expect(trustedClientIp(request({ "x-forwarded-for": "192.0.2.1, 198.51.100.2" }), "x-forwarded-for")).toBeNull();
    expect(trustedClientIp(request({ "x-real-ip": "invented" }), "x-real-ip")).toBeNull();
  });
});

describe("shared authentication limiter", () => {
  it("normalizes account identity without storing email or IP in Redis keys", async () => {
    const evalRedis = vi.fn().mockResolvedValue(0);
    const limit = createAuthRateLimiter({ redis: { eval: evalRedis }, secret: "unit-secret", trustedIpHeader: "x-real-ip" });
    await limit(request({ "x-real-ip": "192.0.2.1" }), { email: "Owner@Example.com" }, "login");
    await limit(request({ "x-real-ip": "192.0.2.1" }), { email: "owner@example.com" }, "login");
    const first = evalRedis.mock.calls[0]!;
    const second = evalRedis.mock.calls[1]!;
    expect(first[1]).toBe(3);
    expect(first.slice(2, 5)).toEqual(second.slice(2, 5));
    expect(first[2]).toMatch(/^aistudy:\{auth:[a-f0-9]{24}\}:login:global$/);
    expect(JSON.stringify(first.slice(2))).not.toMatch(/owner@example|192\.0\.2\.1/i);
  });

  it("always enforces account and global budgets without trusted IP configuration", async () => {
    const evalRedis = vi.fn().mockResolvedValue(0);
    const limit = createAuthRateLimiter({ redis: { eval: evalRedis }, secret: "unit-secret" });
    await limit(request({ "x-forwarded-for": "192.0.2.1" }), { email: "owner@example.com" }, "register");
    expect(evalRedis.mock.calls[0]![1]).toBe(2);
    expect(evalRedis.mock.calls[0]!.slice(-4)).toEqual([20, 60_000, 5, 900_000]);
  });

  it("propagates Redis's cooldown as a 429 without calling it an authentication failure", async () => {
    const limit = createAuthRateLimiter({ redis: { eval: vi.fn().mockResolvedValue(847) }, secret: "unit-secret" });
    await expect(limit(request(), { email: "owner@example.com" }, "login")).rejects.toMatchObject({
      code: "RATE_LIMITED", status: 429, retryAfterSeconds: 847,
    });
  });

  it.each([new Error("redis://private-secret@cache"), "invalid reply", -1])("fails closed on an unavailable or invalid Redis response", async (reply) => {
    const evalRedis = reply instanceof Error ? vi.fn().mockRejectedValue(reply) : vi.fn().mockResolvedValue(reply);
    const limit = createAuthRateLimiter({ redis: { eval: evalRedis }, secret: "unit-secret" });
    await expect(limit(request(), {}, "login")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
    await expect(limit(request(), {}, "login")).rejects.not.toThrow(/private-secret/);
  });
});
