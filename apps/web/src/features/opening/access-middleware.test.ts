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

  it("permanently redirects legacy course deep links and preserves repeated filters", () => {
    vi.stubEnv("OPENING_RELEASE", "1");
    const response = middleware(pageRequest("/learn/courses/course-1?tab=goals&tag=one&tag=two"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`${publicBase}/opening/courses/course-1?tab=goals&tag=one&tag=two`);
  });

  it.each(["production", "development"])("keeps course aliases permanent in %s without the release flag", environment => {
    vi.stubEnv("NODE_ENV", environment);
    vi.stubEnv("OPENING_RELEASE", "0");
    const response = middleware(pageRequest("/learn/courses/course-1"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`${publicBase}/opening/courses/course-1`);
  });

  it.each(["127.0.0.1", "[::1]", "localhost"])("preserves the request host %s when NextURL normalizes loopback names", host => {
    vi.stubEnv("__NEXT_NO_MIDDLEWARE_URL_NORMALIZE", "1");
    const response = middleware(new NextRequest(`http://${host}:3107/learn/courses/course-1?tag=a&tag=b`));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`http://${host}:3107/opening/courses/course-1?tag=a&tag=b`);
  });

  it.each([
    ["/learn/courses", "/opening/courses"],
    ["/learn/courses/new", "/opening/courses/new"],
    ["/library/new", "/opening/library/new"],
    ["/library/source-1", "/opening/library/source-1"],
    ["/search", "/opening/search"],
    ["/settings/advanced", "/opening/settings/advanced"],
    ["/settings/export", "/opening/settings/export"],
    ["/ui-preview", "/opening/today"],
    ["/ui-preview/opening", "/opening/today"],
  ])("preserves a retired page alias %s before removing its page module", (from, target) => {
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("OPENING_RELEASE", "0");
    const response = middleware(pageRequest(`${from}?tag=a&tag=b&version=0&returnTo=%2Fopening%2Ftoday`));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`${publicBase}${target}?tag=a&tag=b&version=0&returnTo=%2Fopening%2Ftoday`);
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

  it("keeps retired mock URLs redirecting in development after their pages are removed", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENING_RELEASE", "0");
    const response = middleware(pageRequest("/learn/goals"));
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

describe("legacy API observation does not change request handling", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_BASE_URL", publicBase);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("records a blocked request without logging credentials or consuming its body", () => {
    const input = new NextRequest(`${publicBase}/api/practice/private-id?token=secret`, {
      method: "POST", body: "private answer", headers: { origin: "https://foreign.example", cookie: "session=secret" },
    });
    expect(middleware(input).status).toBe(403);
    expect(input.bodyUsed).toBe(false);
    expect(console.info).toHaveBeenCalledOnce();
    const event = JSON.parse(vi.mocked(console.info).mock.calls[0]![0] as string);
    expect(event).toMatchObject({ event: "deprecated_api_request", route: "/api/practice/[id]", method: "POST" });
    expect(JSON.stringify(event)).not.toMatch(/private|secret|foreign/);
  });

  it("keeps a same-origin request and active routes unchanged when logging fails", () => {
    vi.mocked(console.info).mockImplementation(() => { throw new Error("stdout unavailable"); });
    const input = new NextRequest(`${publicBase}/api/explorations`, { method: "POST", headers: { origin: publicBase } });
    expect(middleware(input).headers.get("x-middleware-next")).toBe("1");
    vi.mocked(console.info).mockClear();
    expect(middleware(new NextRequest(`${publicBase}/api/courses`, { method: "POST", headers: { origin: publicBase } })).headers.get("x-middleware-next")).toBe("1");
    expect(console.info).not.toHaveBeenCalled();
  });
});

