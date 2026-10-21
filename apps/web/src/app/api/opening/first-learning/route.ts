import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope, getPlanService } from "../../../../features/opening/runtime";
import { getFirstLearningService, getPlanningSettingsService } from "../../../../features/opening/server/data-services";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { startFirstLearning } from "../../../../features/workspace/first-learning-service";

export async function POST(request: Request): Promise<Response> {
  let response: Response;
  try {
    const { sql, scope } = await requireOpeningScope(request);
    const result = await startFirstLearning({
      firstLearning: getFirstLearningService(sql), plans: getPlanService(sql), settings: getPlanningSettingsService(sql),
    }, scope, await readOpeningJsonBody(request, 16_384));
    response = Response.json(result, { status: 201 });
  } catch (error) {
    response = jsonError(mapDomainError(error));
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
