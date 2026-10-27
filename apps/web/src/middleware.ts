import { NextResponse, type NextRequest } from "next/server";
import { isAllowedCookieAuthOrigin } from "./features/opening/access-policy";
import { recordLegacyApiRequest } from "./features/opening/legacy-api-observation";
import { sprintCourseId } from "./features/opening/exam-sprint/sprint-course-route";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Legacy mock-backed experiences must not masquerade as official entries. */
const LEGACY_OPENING_REDIRECTS: { test: (pathname: string) => boolean; target: (pathname: string) => string; permanent?: boolean }[] = [
  { test: p => p === "/learn/courses" || p.startsWith("/learn/courses/"), target: p => `/opening${p.slice("/learn".length)}`, permanent: true },
  { test: p => p === "/library" || p.startsWith("/library/"), target: p => `/opening${p}`, permanent: true },
  { test: p => p === "/settings" || p.startsWith("/settings/"), target: p => `/opening${p}`, permanent: true },
  { test: p => p === "/search", target: () => "/opening/search", permanent: true },
  { test: p => p === "/ui-preview" || p.startsWith("/ui-preview/"), target: () => "/opening/today", permanent: true },
  { test: (p) => p === "/learn", target: () => "/opening/today" },
  {
    test: (p) => p === "/learn/review" || p.startsWith("/learn/review/"),
    target: () => "/opening/cards",
  },
  {
    test: (p) =>
      p === "/learn/practice" || p.startsWith("/learn/practice/") ||
      p === "/learn/goals" || p.startsWith("/learn/goals/") ||
      p === "/learn/exams" || p.startsWith("/learn/exams/") ||
      p === "/learn/marketplace" || p.startsWith("/learn/marketplace/"),
    target: () => "/opening/today",
  },
  { test: (p) => p === "/explore" || p === "/preview" || p.startsWith("/explore/") || p.startsWith("/preview/"), target: () => "/opening/today" },
];

export function legacyOpeningRedirectPath(pathname: string): string | null {
  const rule = LEGACY_OPENING_REDIRECTS.find((candidate) => candidate.test(pathname));
  return rule ? rule.target(pathname) : null;
}

/** Production never derives the trusted origin from the request Host header. */
export function cookieAuthBaseUrl(env: NodeJS.ProcessEnv, requestOrigin: string): string | null {
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured;
  return env.NODE_ENV === "production" ? null : requestOrigin;
}

export function middleware(request: NextRequest) {
  recordLegacyApiRequest(request, { publicBaseUrl: process.env.PUBLIC_BASE_URL, build: process.env.AISTUDY_COMMIT });
  const pathname = request.nextUrl.pathname;
  const legacySprint = /^\/opening\/courses\/([^/]+)(?:\/study)?\/?$/.exec(pathname);
  const sprintId = legacySprint ? sprintCourseId({ courseId: legacySprint[1] }) : null;
  if ((request.method === "GET" || request.method === "HEAD") && sprintId
    && request.nextUrl.searchParams.getAll("mode").length === 1 && request.nextUrl.searchParams.get("mode") === "sprint") {
    const target = new URL(request.url);
    target.pathname = "/opening/sprint";
    target.searchParams.delete("mode");
    target.searchParams.set("courseId", sprintId);
    return NextResponse.redirect(target, 308);
  }
  const legacyRule = LEGACY_OPENING_REDIRECTS.find(candidate => candidate.test(pathname));
  // Retired pages have no UI module left, so old bookmarks resolve in every environment.
  if (legacyRule) {
    // nextUrl folds 127.0.0.1 / ::1 into localhost even with URL normalization
    // disabled. Preserve the raw request authority so host-only cookies survive.
    const target = new URL(request.url);
    target.pathname = legacyRule.target(pathname);
    return NextResponse.redirect(target, legacyRule.permanent ? 308 : 307);
  }
  if (!UNSAFE_METHODS.has(request.method)) {
    return NextResponse.next();
  }
  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const publicBaseUrl = cookieAuthBaseUrl(process.env, request.nextUrl.origin);
  if (!publicBaseUrl) {
    return NextResponse.json(
      { error: { code: "CONFIGURATION", message: "PUBLIC_BASE_URL must be configured in production" } },
      { status: 500 },
    );
  }
  const origin = request.headers.get("origin");
  if (isAllowedCookieAuthOrigin(origin, publicBaseUrl)) {
    return NextResponse.next();
  }

  return NextResponse.json(
    {
      error: {
        code: "FORBIDDEN",
        message: "Same-origin Origin required for cookie-auth mutations",
      },
    },
    { status: 403 },
  );
}
