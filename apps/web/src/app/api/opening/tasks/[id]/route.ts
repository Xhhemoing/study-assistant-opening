import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { getPlanService, requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const task = await getPlanService(sql).updateTaskStatus(scope, id, await readOpeningJsonBody(request));
    return Response.json(task);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
