import { runReadinessProbes } from "../../../../../../../scripts/opening-readiness-probes.mjs";
import { jsonError, mapDomainError, requirePrincipal } from "../../../../features/auth/service";
import { summarizeOpeningHealth } from "../../../../features/opening/health/health-summary";
import { getAuthRuntime } from "../../../../server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let response: Response;
  try {
    if (new URL(request.url).searchParams.get("details") !== "1") {
      response = Response.json({ status: "ok" });
    } else {
      await requirePrincipal(getAuthRuntime(), request);
      const probes = await runReadinessProbes(process.env);
      const body = summarizeOpeningHealth(probes);
      response = Response.json(body, { status: body.status === "ok" ? 200 : 503 });
    }
  } catch (error) {
    response = jsonError(mapDomainError(error));
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
