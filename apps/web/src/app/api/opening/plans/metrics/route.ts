import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { getOpeningLoopMetrics } from "../../../../../features/opening/planning/loop-metrics-service";

export async function GET(request: Request): Promise<Response> {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const parameters = new URL(request.url).searchParams;
    response = Response.json(await getOpeningLoopMetrics(sql, scope, parameters.get("days") ?? undefined));
  } catch (error) {
    response = jsonError(mapDomainError(error));
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
