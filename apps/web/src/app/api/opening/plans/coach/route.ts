import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { createOpeningCoachPlanService } from "../../../../../features/opening/server/coach-plan-service";

export async function GET(request: Request): Promise<Response> {
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const result = Response.json(await createOpeningCoachPlanService(sql).summary(scope, new URL(request.url).searchParams.get("date")));
    result.headers.set("Cache-Control", "no-store");
    return result;
  } catch (error) { return jsonError(mapDomainError(error)); }
}
