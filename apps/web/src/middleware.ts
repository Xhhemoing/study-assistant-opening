import { NextResponse, type NextRequest } from "next/server";
import { isAllowedCookieAuthOrigin, isOpeningRelease } from "./features/opening/access-policy";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Legacy mock-backed experiences must not masquerade as official entries. */
const LEGACY_OPENING_REDIRECTS: { test: (pathname: string) => boolean }[] = [
  { test: (p) => p === "/learn" || p === "/explore" || p.startsWith("/preview") },
];

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (
    isOpeningRelease() &&
    LEGACY_OPENING_REDIRECTS.some((rule) => rule.test(pathname))
  ) {
    return NextResponse.redirect(new URL("/opening/today", request.url));
  }
  if (!UNSAFE_METHODS.has(request.method)) {
    return NextResponse.next();
  }
  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const publicBaseUrl =
    process.env.PUBLIC_BASE_URL?.trim() || request.nextUrl.origin;
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
