import { uuidSchema } from "@aistudy/contracts";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { getLearningReadService, requireOpeningScope } from "../../../../../../features/opening/runtime";

/** Includes withdrawal heads for history inspection; owner and course checks precede reads. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const courseId = uuidSchema.parse((await context.params).id);
    return Response.json(await getLearningReadService(sql).listLearningObservations(scope, courseId));
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
