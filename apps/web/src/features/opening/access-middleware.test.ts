import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cookieAuthBaseUrl, middleware } from "../../middleware";
import { OPENING_TEST_FIXTURE_ORIGIN } from "./access-policy";

const publicBase = "https://study.example";

function request(method: string, origin?: string, base = publicBase) {
  return new NextRequest(`${base}/api/opening/turns`, {
    method,
    headers: origin ? { origin } : {},
  });
}

function pageRequest(pathname: string) {
  return new NextRequest(`${publicBase}${pathname}`);
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

  it("keeps legacy course links outside the Opening redirect", () => {
    vi.stubEnv("OPENING_RELEASE", "1");
    const response = middleware(pageRequest("/learn/courses/course-1?tab=goals"));
    expect(response.status).toBe(200);
  });
  it.each([
    "/learn/review",
    "/learn/practice/x",
    "/learn/goals",
    "/learn/goals/new",
    "/learn/exams",
    "/learn/marketplace",
  ])("redirects mock-backed legacy learning page %s", (pathname) => {
    vi.stubEnv("OPENING_RELEASE", "1");
    const response = middleware(pageRequest(pathname));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${publicBase}/opening/today`);
  });
});

describe("cookie-auth base URL configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails closed for mutations when production has no PUBLIC_BASE_URL", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_BASE_URL", "");
    const response = middleware(request("POST", publicBase));
    expect(response.status).toBe(500);
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: "CONFIGURATION" } });
  });

  it("still serves reads when production has no PUBLIC_BASE_URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_BASE_URL", "");
    expect(middleware(request("GET", publicBase)).headers.get("x-middleware-next")).toBe("1");
  });

  it("falls back to the request origin only outside production", () => {
    expect(cookieAuthBaseUrl({ NODE_ENV: "development" } as NodeJS.ProcessEnv, "http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(cookieAuthBaseUrl({ NODE_ENV: "production" } as NodeJS.ProcessEnv, "http://127.0.0.1:3000")).toBeNull();
    expect(cookieAuthBaseUrl({ NODE_ENV: "production", PUBLIC_BASE_URL: " https://study.example " } as NodeJS.ProcessEnv, "http://evil.example")).toBe("https://study.example");
  });
});

