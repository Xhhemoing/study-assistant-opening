import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { getLongTermPlanningService } from "../../../../../features/opening/planning/long-term-runtime";
export async function GET(request: Request) {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    return Response.json(await getLongTermPlanningService(sql).read(scope, new URL(request.url).searchParams.get("date")), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
export async function POST(request: Request) {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    return Response.json(await getLongTermPlanningService(sql).command(scope, await readOpeningJsonBody(request)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
