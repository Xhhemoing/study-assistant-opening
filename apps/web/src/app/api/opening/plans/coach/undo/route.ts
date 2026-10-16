import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { createOpeningCoachPlanService } from "../../../../../../features/opening/server/coach-plan-service";

export async function POST(request: Request): Promise<Response> {
  try {
    const { sql, scope } = await requireOpeningScope(request);
    return Response.json(await createOpeningCoachPlanService(sql).undo(scope, await readOpeningJsonBody(request)));
  } catch (error) { return jsonError(mapDomainError(error)); }
}
