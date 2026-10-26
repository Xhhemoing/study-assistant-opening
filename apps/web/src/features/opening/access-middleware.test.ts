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
    // PRODUCT DECISION: /learn/courses* stays reachable so existing course deep
    // links are not broken. Mock was stripped from that page instead of redirecting.
    vi.stubEnv("OPENING_RELEASE", "1");
    const response = middleware(pageRequest("/learn/courses/course-1?tab=goals"));
    expect(response.status).toBe(200);
  });

  it("keeps legacy course links outside production mock redirects too", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENING_RELEASE", "0");
    const response = middleware(pageRequest("/learn/courses/course-1"));
    expect(response.status).toBe(200);
  });

  it.each([
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

  it.each([
    ["/learn", "/opening/today"],
    ["/learn/practice/mock-item", "/opening/today"],
    ["/learn/goals", "/opening/today"],
    ["/learn/review", "/opening/cards"],
    ["/learn/review/session", "/opening/cards"],
    ["/explore", "/opening/today"],
    ["/explore/thread-1", "/opening/today"],
    ["/preview", "/opening/today"],
    ["/preview/notebook", "/opening/today"],
  ])("redirects legacy mock alias %s in production without OPENING_RELEASE", (pathname, target) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENING_RELEASE", "");
    const response = middleware(pageRequest(pathname));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${publicBase}${target}`);
  });

  it("redirects legacy review pages to opening memory cards", () => {
    vi.stubEnv("OPENING_RELEASE", "1");
    for (const pathname of ["/learn/review", "/learn/review/session"]) {
      const response = middleware(pageRequest(pathname));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(`${publicBase}/opening/cards`);
    }
  });

  it("does not redirect mock legacy pages in development without OPENING_RELEASE", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENING_RELEASE", "0");
    const response = middleware(pageRequest("/learn/goals"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
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


const sprintCourse = "11111111-1111-4111-8111-111111111111";
describe("legacy sprint compatibility", () => {
  it.each([["", "GET"], ["/study", "GET"], ["", "HEAD"], ["/study", "HEAD"]])("permanently redirects the old course%s entry via %s without losing query context", (suffix, method) => {
    const request = new NextRequest(`${publicBase}/opening/courses/${sprintCourse}${suffix}?mode=sprint&conversation=kept&filter=a&filter=b&courseId=old`, { method });
    const response = middleware(request);
    expect(response.status).toBe(308);
    const target = new URL(response.headers.get("location")!);
    expect(target.pathname).toBe("/opening/sprint");
    expect(target.searchParams.get("courseId")).toBe(sprintCourse);
    expect(target.searchParams.get("conversation")).toBe("kept");
    expect(target.searchParams.getAll("filter")).toEqual(["a", "b"]);
    expect(target.searchParams.has("mode")).toBe(false);
    expect(middleware(new NextRequest(target)).headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    `/opening/courses/${sprintCourse}/study?mode=practice`,
    `/opening/courses/${sprintCourse}/study?mode=sprint&mode=practice`,
    "/opening/courses/not-a-course/study?mode=sprint",
    `/opening/courses/${sprintCourse}/exam?mode=sprint`,
  ])("keeps other or ambiguous course entries unchanged: %s", path => {
    expect(middleware(pageRequest(path)).headers.get("x-middleware-next")).toBe("1");
  });
});
it.each(["POST", "PUT"])("does not redirect a %s sent to a legacy sprint page", method => {
  const response = middleware(new NextRequest(`${publicBase}/opening/courses/${sprintCourse}/study?mode=sprint`, { method }));
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("x-middleware-next")).toBe("1");
});