import { NextResponse, type NextRequest } from "next/server";
import { isAllowedCookieAuthOrigin } from "./features/opening/access-policy";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function middleware(request: NextRequest) {
  if (!UNSAFE_METHODS.has(request.method)) {
    return NextResponse.next();
  }

  const pathname = request.nextUrl.pathname;
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

export const config = {
  matcher: ["/api/:path*"],
};
