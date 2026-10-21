const SESSION_EXPIRED_EVENT = "aistudy:session-expired";
const notifiedWindows = new WeakSet<Window>();
const sessionGenerations = new WeakMap<Window, number>();

/** Keep the current document (including memory-only drafts) mounted on expiry. */
export function subscribeToSessionExpiry(onExpired: () => void): () => void {
  window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
  return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
}

export function clearSessionExpiry(): void {
  if (typeof window === "undefined") return;
  notifiedWindows.delete(window);
  sessionGenerations.set(window, (sessionGenerations.get(window) ?? 0) + 1);
}

function isLocalApiRequest(input: RequestInfo | URL): boolean {
  if (typeof window === "undefined" || !window.location?.href) return false;
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
  return url.origin === window.location.origin && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth/");
}

/** Inspect only explicit session failures; leave response bodies and HTTP errors intact. */
export function createSessionFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    // Do not send the retained document's data under a newly signed-in identity.
    // AuthGate releases this latch only after verifying the original user/workspace.
    if (isLocalApiRequest(input) && notifiedWindows.has(window)) {
      return Response.json({ error: { code: "UNAUTHENTICATED", message: "请先登录原账户并验证，再继续操作。" } }, { status: 401 });
    }
    const generation = typeof window === "undefined" ? 0 : sessionGenerations.get(window) ?? 0;
    const response = await fetchImpl(input, init);
    if (response.status !== 401 || !isLocalApiRequest(input)) return response;
    // A provider's 401 (or a non-JSON gateway response) is not proof of session expiry.
    const body: unknown = await response.clone().json().catch(() => null);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted || !body || typeof body !== "object" || !("error" in body)) return response;
    const error = body.error;
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "UNAUTHENTICATED") return response;
    // A response from before successful reauthentication cannot expire the new session.
    if (generation !== (sessionGenerations.get(window) ?? 0)) return response;
    if (/^\/(login|register)\/?$/.test(window.location.pathname) || notifiedWindows.has(window)) return response;
    notifiedWindows.add(window);
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    return response;
  };
}
