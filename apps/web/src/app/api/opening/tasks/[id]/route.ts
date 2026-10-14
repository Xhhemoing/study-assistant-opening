import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { getPlanService, requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";

/** Status update ({status, expectedVersion, at}) or deferral ({notBefore, expectedVersion}). */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const body = await readOpeningJsonBody(request);
    const service = getPlanService(sql);
    const isDeferral = typeof body === "object" && body !== null && "notBefore" in body;
    const task = isDeferral
      ? await service.deferTask(scope, id, body)
      : await service.updateTaskStatus(scope, id, body);
    return Response.json(task);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
