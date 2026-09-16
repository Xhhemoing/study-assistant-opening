import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { middleware } from "../../middleware";
import { OPENING_TEST_FIXTURE_ORIGIN } from "./access-policy";

const publicBase = "https://study.example";

function request(method: string, origin?: string, base = publicBase) {
  return new NextRequest(`${base}/api/opening/turns`, {
    method,
    headers: origin ? { origin } : {},
  });
}

describe("opening same-origin middleware", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_BASE_URL", publicBase);
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "rejects foreign fixture origin for %s in production",
    async (method) => {
      const response = middleware(request(method, OPENING_TEST_FIXTURE_ORIGIN));
      expect(response.status).toBe(403);
      expect(response.headers.get("x-middleware-next")).toBeNull();
      expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    },
  );

  it("continues a same-origin mutation", () => {
    const response = middleware(request("POST", publicBase));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([undefined, "https://foreign.example"])(
    "rejects missing or foreign origin (%s)",
    (origin) => {
      expect(middleware(request("POST", origin)).status).toBe(403);
    },
  );

  it("allows a fixture only when it is the configured application origin", () => {
    vi.stubEnv("PUBLIC_BASE_URL", OPENING_TEST_FIXTURE_ORIGIN);
    const response = middleware(request("POST", OPENING_TEST_FIXTURE_ORIGIN, OPENING_TEST_FIXTURE_ORIGIN));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not apply mutation checks to a read request", () => {
    const response = middleware(request("GET", "https://foreign.example"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
