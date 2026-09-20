/** Opening-release access policy (registration + cookie-auth origin). */

export const OPENING_TEST_FIXTURE_ORIGIN = "http://opening-fixture.test";

export function allowRegistration(input: {
  openingRelease: boolean;
}): boolean {
  return !input.openingRelease;
}

export function isOpeningRelease(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.OPENING_RELEASE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** Local preview: treat localhost and 127.0.0.1 as the same loopback host. */
function loopbackEquivalent(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    if (left.protocol !== right.protocol) return false;
    if (left.port !== right.port) return false;
    const hosts = new Set([left.hostname, right.hostname]);
    return hosts.size === 2 && hosts.has("localhost") && hosts.has("127.0.0.1");
  } catch {
    return false;
  }
}

/**
 * Unsafe cookie-auth requests must present a same-origin Origin.
 * Fixtures use their configured application origin, never a cross-origin bypass.
 */
export function assertAllowedCookieAuthOrigin(
  originHeader: string | null | undefined,
  publicBaseUrl: string,
): void {
  if (!originHeader?.trim()) {
    throw new Error("Missing Origin for cookie-auth mutation");
  }
  const origin = normalizeOrigin(originHeader);
  if (!origin) {
    throw new Error("Invalid Origin for cookie-auth mutation");
  }
  const allowed = normalizeOrigin(publicBaseUrl);
  if (!allowed) {
    throw new Error("Foreign Origin denied for cookie-auth mutation");
  }
  if (origin !== allowed && !loopbackEquivalent(origin, allowed)) {
    throw new Error("Foreign Origin denied for cookie-auth mutation");
  }
}

export function isAllowedCookieAuthOrigin(
  originHeader: string | null | undefined,
  publicBaseUrl: string,
): boolean {
  try {
    assertAllowedCookieAuthOrigin(originHeader, publicBaseUrl);
    return true;
  } catch {
    return false;
  }
}
