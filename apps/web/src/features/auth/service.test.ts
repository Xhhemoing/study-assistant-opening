import { describe, expect, it } from "vitest";
import {
  RETEST_SUBMIT_TOO_EARLY_CODE,
  RETEST_SUBMIT_TOO_EARLY_MESSAGE,
  RetestSubmitTooEarlyError,
} from "@aistudy/domain";
import { jsonError, mapDomainError, sessionCookieHeader, type AuthRuntime } from "./service";

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

describe("mapDomainError RetestSubmitTooEarlyError (DL11)", () => {
  it("maps to 400 VALIDATION with businessCode and earliestAt for Experience", async () => {
    const early = new RetestSubmitTooEarlyError({
      code: RETEST_SUBMIT_TOO_EARLY_CODE,
      reason: "scheduled_or_recommended",
      earliestAt: "2026-09-15T16:00:00.000Z",
      message: RETEST_SUBMIT_TOO_EARLY_MESSAGE,
    });
    const mapped = mapDomainError(early);
    expect(mapped.code).toBe("VALIDATION");
    expect(mapped.status).toBe(400);
    expect(mapped.message).toBe(RETEST_SUBMIT_TOO_EARLY_MESSAGE);
    expect((mapped as { businessCode?: string }).businessCode).toBe(RETEST_SUBMIT_TOO_EARLY_CODE);
    expect((mapped as { earliestAt?: string }).earliestAt).toBe("2026-09-15T16:00:00.000Z");

    const response = jsonError(mapped);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VALIDATION",
        message: RETEST_SUBMIT_TOO_EARLY_MESSAGE,
        businessCode: RETEST_SUBMIT_TOO_EARLY_CODE,
        earliestAt: "2026-09-15T16:00:00.000Z",
        reason: "scheduled_or_recommended",
      },
    });
  });
});
