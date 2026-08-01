import { describe, expect, it } from "vitest";
import { sessionCookieHeader, type AuthRuntime } from "./service";

function runtime(sessionCookieSecure: boolean): AuthRuntime {
  return {
    authCookieName: "aistudy_session",
    sessionCookieSecure,
  } as AuthRuntime;
}

describe("sessionCookieHeader", () => {
  const expiresAt = new Date("2030-01-01T00:00:00.000Z");

  it("omits Secure when an explicit HTTP test runtime disables it", () => {
    expect(sessionCookieHeader(runtime(false), "token", expiresAt)).not.toContain("Secure");
  });

  it("includes Secure when the runtime requires HTTPS", () => {
    expect(sessionCookieHeader(runtime(true), "token", expiresAt)).toContain("Secure");
  });
});
