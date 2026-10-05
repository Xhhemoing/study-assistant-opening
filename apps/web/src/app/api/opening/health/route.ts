import { runReadinessProbes } from "../../../../../../../scripts/opening-readiness-probes.mjs";
import { summarizeOpeningHealth } from "../../../../features/opening/health/health-summary";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const probes = await runReadinessProbes(process.env);
  const body = summarizeOpeningHealth(probes);
  return Response.json(body, { status: body.status === "ok" ? 200 : 503 });
}
