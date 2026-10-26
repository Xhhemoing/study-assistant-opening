type ObservedRequest = Pick<Request, "url" | "method" | "headers">;
type ObservationOptions = { publicBaseUrl?: string; build?: string; now?: Date };

const ROUTES = [
  [/^\/api\/explorations\/?$/, "/api/explorations"],
  [/^\/api\/explorations\/[^/]+\/?$/, "/api/explorations/[id]"],
  [/^\/api\/explorations\/[^/]+\/blocks\/?$/, "/api/explorations/[id]/blocks"],
  [/^\/api\/explorations\/[^/]+\/branches\/?$/, "/api/explorations/[id]/branches"],
  [/^\/api\/explorations\/[^/]+\/status\/?$/, "/api/explorations/[id]/status"],
  [/^\/api\/explorations\/[^/]+\/promotions\/?$/, "/api/explorations/[id]/promotions"],
  [/^\/api\/promotions\/[^/]+\/accept\/?$/, "/api/promotions/[id]/accept"],
  [/^\/api\/promotions\/[^/]+\/reject\/?$/, "/api/promotions/[id]/reject"],
  [/^\/api\/practice\/[^/]+\/?$/, "/api/practice/[id]"],
  [/^\/api\/practice\/[^/]+\/hint\/?$/, "/api/practice/[id]/hint"],
  [/^\/api\/practice\/[^/]+\/reveal\/?$/, "/api/practice/[id]/reveal"],
  [/^\/api\/revision-proposals\/[^/]+\/?$/, "/api/revision-proposals/[id]"],
] as const;
const CALLERS = new Set(["opening.editor", "opening.courses", "opening.suggestions", "script"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const isWithin = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

function caller(request: ObservedRequest, publicBaseUrl?: string) {
  const hint = request.headers.get("x-aistudy-caller");
  if (hint && CALLERS.has(hint)) return { caller: hint, callerSource: "header_hint" };
  const referer = request.headers.get("referer");
  if (referer && publicBaseUrl) {
    try {
      const source = new URL(referer);
      if (!source.username && !source.password && source.origin === new URL(publicBaseUrl).origin) {
        const label = isWithin(source.pathname, "/opening/library") ? "opening.editor"
          : isWithin(source.pathname, "/opening/courses") ? "opening.courses"
          : isWithin(source.pathname, "/opening/suggestions") ? "opening.suggestions"
          : isWithin(source.pathname, "/opening") ? "opening"
          : isWithin(source.pathname, "/learn") ? "legacy.learn"
          : isWithin(source.pathname, "/explore") ? "legacy.explore" : "application";
        return { caller: label, callerSource: "same_origin_referer" };
      }
    } catch { /* Invalid or foreign referrers carry no caller identity. */ }
  }
  return { caller: "unknown", callerSource: "unknown" };
}

/** Receipt-only telemetry. Caller hints never establish identity or permission. */
export function legacyApiObservation(request: ObservedRequest, options: ObservationOptions = {}) {
  const pathname = new URL(request.url).pathname;
  const route = ROUTES.find(([pattern]) => pattern.test(pathname))?.[1];
  if (!route || route === "/api/revision-proposals/[id]" && !["GET", "HEAD"].includes(request.method)) return null;
  return {
    event: "deprecated_api_request", observedAt: (options.now ?? new Date()).toISOString(), route,
    method: METHODS.has(request.method) ? request.method : "OTHER", ...caller(request, options.publicBaseUrl),
    build: options.build && /^[a-f0-9]{7,40}$/i.test(options.build) ? options.build.toLowerCase() : null,
  };
}

export function recordLegacyApiRequest(request: ObservedRequest, options: ObservationOptions,
  write = (event: NonNullable<ReturnType<typeof legacyApiObservation>>) => console.info(JSON.stringify(event))) {
  const event = legacyApiObservation(request, options);
  if (event) {
    try { write(event); }
    catch { /* Losing telemetry must not replace an authentication or API response. */ }
  }
}
