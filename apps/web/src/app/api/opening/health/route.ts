import { runReadinessProbes } from "../../../../../../../scripts/opening-readiness-probes.mjs";

export const runtime = "nodejs";

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

export async function GET(): Promise<Response> {
  const probes = await runReadinessProbes(process.env);
  const body = summarizeOpeningHealth(probes);
  return Response.json(body, { status: body.status === "ok" ? 200 : 503 });
}
