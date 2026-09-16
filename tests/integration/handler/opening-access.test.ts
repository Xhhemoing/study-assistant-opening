import { afterEach, describe, expect, it } from "vitest";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { OPENING_TEST_FIXTURE_ORIGIN } from "../../../apps/web/src/features/opening/access-policy";
import { isAllowedCookieAuthOrigin } from "../../../apps/web/src/features/opening/access-policy";

function registrationRequest(body: unknown, origin?: string) {
  return new Request(`${OPENING_TEST_FIXTURE_ORIGIN}/api/auth/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("opening access handlers", () => {
  const previous = process.env.OPENING_RELEASE;

  afterEach(() => {
    if (previous === undefined) delete process.env.OPENING_RELEASE;
    else process.env.OPENING_RELEASE = previous;
  });

  it("returns 403 for public registration when opening release is enabled", async () => {
    process.env.OPENING_RELEASE = "1";
    const response = await register(
      registrationRequest(
        {
          email: "owner@example.com",
          password: "password123",
          displayName: "Owner",
        },
        OPENING_TEST_FIXTURE_ORIGIN,
      ),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("WORKSPACE_FORBIDDEN");
  });

  it("denies missing Origin for cookie-auth mutations (policy)", () => {
    expect(
      isAllowedCookieAuthOrigin(null, "http://localhost:3000"),
    ).toBe(false);
    expect(
      isAllowedCookieAuthOrigin(
        "https://evil.example",
        "http://localhost:3000",
      ),
    ).toBe(false);
    expect(
      isAllowedCookieAuthOrigin(
        OPENING_TEST_FIXTURE_ORIGIN,
        "http://localhost:3000",
      ),
    ).toBe(false);
    expect(
      isAllowedCookieAuthOrigin(
        OPENING_TEST_FIXTURE_ORIGIN,
        OPENING_TEST_FIXTURE_ORIGIN,
      ),
    ).toBe(true);
  });
});
