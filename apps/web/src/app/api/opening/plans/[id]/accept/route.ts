import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { getPlanService, requireOpeningScope } from "../../../../../../features/opening/runtime";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const body = await request.json();
    const accepted = await getPlanService(sql).acceptPlan(scope, {
      ...body,
      draftId: id,
    });
    return Response.json(accepted);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
