import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { getPlanService, requireOpeningScope } from "../../../../../../features/opening/runtime";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const rejected = await getPlanService(sql).rejectPlan(scope, id);
    return Response.json(rejected);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
