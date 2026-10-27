import { createLearningGoalService } from "../../../../../features/opening/courses/learning-goal-service";
import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  let response: Response;
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const { id } = await context.params;
    response = Response.json(await createLearningGoalService(sql).update(scope, id, await readOpeningJsonBody(request, 32_768)));
  } catch (error) { response = jsonError(mapDomainError(error)); }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
