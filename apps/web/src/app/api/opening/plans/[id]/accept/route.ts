import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { getPlanService, requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const body = await readOpeningJsonBody(request);
    const accepted = await getPlanService(sql).acceptPlan(scope, {
      ...(body as Record<string, unknown>),
      draftId: id,
    });
    return Response.json(accepted);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
