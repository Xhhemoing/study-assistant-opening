import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, loginUser, registerUser } from "./service";
import { enforceAuthRateLimit } from "../../server/auth-throttle";
import { getAuthRuntime } from "../../server/runtime";
import { POST as login } from "../../app/api/auth/login/route";
import { POST as register } from "../../app/api/auth/register/route";

vi.mock("../../server/auth-throttle", () => ({ enforceAuthRateLimit: vi.fn() }));
vi.mock("../../server/runtime", () => ({ getAuthRuntime: vi.fn() }));
vi.mock("./service", async (importOriginal) => ({
  ...await importOriginal<typeof import("./service")>(),
  loginUser: vi.fn(),
  registerUser: vi.fn(),
}));

function jsonRequest(body: string): Request {
  return new Request("http://localhost/api/auth", { method: "POST", body, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("OPENING_RELEASE", "0");
  vi.mocked(enforceAuthRateLimit).mockResolvedValue(undefined);
  vi.mocked(getAuthRuntime).mockReturnValue({ authCookieName: "session", sessionCookieSecure: false } as ReturnType<typeof getAuthRuntime>);
  const result = { user: { id: "user", email: "owner@example.com", displayName: "Owner", workspaceId: "workspace" }, token: "token", expiresAt: new Date("2030-01-01") };
  vi.mocked(loginUser).mockResolvedValue(result);
  vi.mocked(registerUser).mockResolvedValue(result);
});
afterEach(() => vi.unstubAllEnvs());

describe.each([["login", login, loginUser, 200], ["register", register, registerUser, 201]] as const)("%s HTTP boundary", (action, route, authenticate, successStatus) => {
  it("rejects oversized streamed JSON before rate-limit storage or password work", async () => {
    const response = await route(jsonRequest(JSON.stringify({ email: "owner@example.com", password: "x".repeat(8 * 1024) })));
    expect(response.status).toBe(413);
    expect(enforceAuthRateLimit).not.toHaveBeenCalled();
    expect(getAuthRuntime).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before password work", async () => {
    expect((await route(jsonRequest("{"))).status).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("checks the shared limiter before authenticating", async () => {
    vi.mocked(enforceAuthRateLimit).mockRejectedValueOnce(new ApiError("RATE_LIMITED", "稍后重试", 429, 60));
    const response = await route(jsonRequest('{"email":"owner@example.com","password":"password"}'));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("keeps the successful cookie response after admission", async () => {
    const body = { email: "owner@example.com", password: "password", displayName: "Owner" };
    const response = await route(jsonRequest(JSON.stringify(body)));
    expect(response.status).toBe(successStatus);
    expect(enforceAuthRateLimit).toHaveBeenCalledWith(expect.any(Request), body, action);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(response.headers.get("Set-Cookie")).toContain("session=token;");
  });
});

it("rejects registration in production without an explicit public registration switch", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("OPENING_RELEASE", undefined);
  expect((await register(jsonRequest("{}"))).status).toBe(403);
  expect(enforceAuthRateLimit).not.toHaveBeenCalled();
});
