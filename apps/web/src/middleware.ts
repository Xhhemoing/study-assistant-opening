import { NextResponse, type NextRequest } from "next/server";
import { isAllowedCookieAuthOrigin, isOpeningRelease } from "./features/opening/access-policy";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Legacy mock-backed experiences must not masquerade as official entries. */
const LEGACY_OPENING_REDIRECTS: { test: (pathname: string) => boolean; target: (pathname: string) => string }[] = [
  { test: (p) => p === "/learn", target: () => "/opening/today" },
  {
    test: (p) =>
      p === "/learn/review" || p.startsWith("/learn/review/") ||
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
  const pathname = request.nextUrl.pathname;
  const legacyRedirect = legacyOpeningRedirectPath(pathname);
  if (isOpeningRelease() && legacyRedirect) {
    const target = request.nextUrl.clone();
    target.pathname = legacyRedirect;
    return NextResponse.redirect(target);
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
