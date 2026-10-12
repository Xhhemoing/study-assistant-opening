/**
 * Isolated opening-release test database guard.
 * Destructive tests must opt in with OPENING_TEST_DB=1 and an exact loopback DB.
 */
const REQUIRED_DB_NAME = "aistudy_opening_test";
/**
 * PR-B: optional one-off scratch database for cross-midnight e2e runs.
 * OPENING_TEST_DB_SCRATCH_NAME must look like aistudy_prb_scratch_<8-14 digits>;
 * when unset the required name stays exactly aistudy_opening_test (default unchanged).
 */
const SCRATCH_DB_NAME = /^aistudy_prb_scratch_[0-9]{8,14}$/;
export function requiredOpeningTestDbName(env: Record<string, string | undefined> = process.env): string {
  const scratch = env.OPENING_TEST_DB_SCRATCH_NAME?.trim();
  if (!scratch) return REQUIRED_DB_NAME;
  if (!SCRATCH_DB_NAME.test(scratch)) {
    throw new Error(`Refusing OPENING_TEST_DB_SCRATCH_NAME ${scratch}: must match aistudy_prb_scratch_<digits>`);
  }
  return scratch;
}
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function assertOpeningTestDatabase(
  url: string,
  enabled: string | undefined,
): URL {
  if (enabled !== "1") {
    throw new Error(
      "Refusing destructive tests: set OPENING_TEST_DB=1 for the isolated opening test database",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("OPENING_TEST_DATABASE_URL is not a valid URL");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("OPENING_TEST_DATABASE_URL must use the postgres scheme");
  }

  // postgres.js forwards this query key into startup parameters after the path DB.
  if (parsed.searchParams.has("database")) {
    throw new Error("Refusing database query parameter in isolated test URL");
  }

  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing destructive tests: database host must be loopback, got ${parsed.hostname}`,
    );
  }

  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const requiredName = requiredOpeningTestDbName();
  if (dbName !== requiredName) {
    throw new Error(
      `Refusing destructive tests: database name must be exactly ${requiredName}, got ${dbName || "(empty)"}`,
    );
  }

  return parsed;
}

/** Vitest globalSetup for handler + integration projects. */
export async function setup(): Promise<void> {
  const raw = process.env.OPENING_TEST_DATABASE_URL;
  if (!raw?.trim()) {
    throw new Error(
      "OPENING_TEST_DATABASE_URL is required for handler/integration projects",
    );
  }
  const validated = assertOpeningTestDatabase(raw, process.env.OPENING_TEST_DB);
  process.env.DATABASE_URL = validated.toString();
}
