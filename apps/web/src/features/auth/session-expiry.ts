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

/** Shared boundary for fetch and the same-origin XHR staging upload. */
export function guardSessionRequest(input: RequestInfo | URL) {
  const target = typeof window === "undefined" ? undefined : window;
  const local = isLocalApiRequest(input);
  const generation = target ? sessionGenerations.get(target) ?? 0 : 0;
  return {
    blocked: Boolean(local && target && notifiedWindows.has(target)),
    inspectFailure(status: number, body: unknown): void {
      if (!target || !local || status !== 401 || !body || typeof body !== "object" || !("error" in body)) return;
      const error = body.error;
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "UNAUTHENTICATED") return;
      // Late responses cannot expire a session verified since this request began.
      if (generation !== (sessionGenerations.get(target) ?? 0)) return;
      if (/^\/(login|register)\/?$/.test(target.location.pathname) || notifiedWindows.has(target)) return;
      notifiedWindows.add(target);
      target.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    },
  };
}

export function isSessionExpired(): boolean {
  return typeof window !== "undefined" && notifiedWindows.has(window);
}

/** Inspect only explicit session failures; leave response bodies and HTTP errors intact. */
export function createSessionFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const guard = guardSessionRequest(input);
    // AuthGate releases this latch only after verifying the original user/workspace.
    if (guard.blocked) {
      return Response.json({ error: { code: "UNAUTHENTICATED", message: "请先登录原账户并验证，再继续操作。" } }, { status: 401 });
    }
    const response = await fetchImpl(input, init);
    if (response.status !== 401 || !isLocalApiRequest(input)) return response;
    const body: unknown = await response.clone().json().catch(() => null);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (!signal?.aborted) guard.inspectFailure(response.status, body);
    return response;
  };
}

type InstalledFetch = { original: typeof fetch; wrapped: typeof fetch; users: number };
const installedFetches = new WeakMap<Window, InstalledFetch>();

/** Install before protected children mount; restore only the fetch this gate owns. */
export function installSessionFetch(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const target = window;
  let installation = installedFetches.get(target);
  if (!installation || target.fetch !== installation.wrapped) {
    const original = target.fetch;
    installation = { original, wrapped: createSessionFetch(original.bind(target)), users: 0 };
    installedFetches.set(target, installation);
    target.fetch = installation.wrapped;
  }
  installation.users += 1;
  const installed = installation;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    installed.users -= 1;
    if (installed.users > 0) return;
    if (target.fetch === installed.wrapped) target.fetch = installed.original;
    if (installedFetches.get(target) === installed) installedFetches.delete(target);
  };
}
