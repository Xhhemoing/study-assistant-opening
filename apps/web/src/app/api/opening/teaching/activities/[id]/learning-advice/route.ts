import { jsonError, mapDomainError } from "../../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../../features/opening/runtime";
import {
  createSqlOpeningLearningAdviceService,
  parseLearningAdviceRequest,
} from "../../../../../../../features/opening/teaching/learning-advice-service";
import { teachingLoopApiDenied } from "../../../../../../../server/opening-config";

/** Authenticated, read-only rule projection. Teaching rollout is not an experiment grant. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  let response: Response;
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const denied = teachingLoopApiDenied(scope.ownerUserId);
    if (denied) return denied;
    const { id } = await context.params;
    const input = await parseLearningAdviceRequest(request, id);
    const service = createSqlOpeningLearningAdviceService(sql);
    response = Response.json(await service.read(scope, id, input));
  } catch (error) {
    response = jsonError(mapDomainError(error));
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
