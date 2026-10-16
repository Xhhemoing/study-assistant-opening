import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { getPlanService, requireOpeningScope } from "../../../../../features/opening/runtime";

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const days = new URL(request.url).searchParams.get("days") ?? 7;
    return Response.json(await getPlanService(sql).getFeedbackSummary(scope, days));
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
