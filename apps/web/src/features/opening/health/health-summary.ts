/**
 * Public health projection: only coarse up/down per dependency, never probe details.
 * Full §Q03 readiness (ownerSetup, registration403, HTTPS, provider, dailyCap,
 * backupFreshness, honest alertDelivery) lives in `scripts/opening-readiness.mjs`,
 * not this public route — keep secrets and supervision metadata off the wire.
 */
type ProbeResult = { ok?: boolean };
type ProbeSet = Record<string, ProbeResult | undefined>;

const PUBLIC_CHECKS = ["database", "redis", "storage", "workerBacklog"] as const;

export function summarizeOpeningHealth(probes: ProbeSet) {
  const checks = Object.fromEntries(PUBLIC_CHECKS.map((name) => [
    name,
    probes[name]?.ok === true ? "up" : "down",
  ]));
  return {
    status: Object.values(checks).every((value) => value === "up") ? "ok" : "down",
    checks,
  } as {
    status: "ok" | "down";
    checks: Record<(typeof PUBLIC_CHECKS)[number], "up" | "down">;
  };
}
