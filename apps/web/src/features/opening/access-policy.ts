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

/**
 * Unsafe cookie-auth requests must present a same-origin Origin
 * (or the explicit test fixture origin). Missing/foreign Origin denied.
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
  if (origin === OPENING_TEST_FIXTURE_ORIGIN) {
    return;
  }
  const allowed = normalizeOrigin(publicBaseUrl);
  if (!allowed || origin !== allowed) {
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
