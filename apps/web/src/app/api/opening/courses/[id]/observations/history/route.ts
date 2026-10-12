import { jsonError, mapDomainError } from "../../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../../features/opening/runtime";
import { parseCourseLearningHistoryRequest } from "../../../../../../../features/opening/learning/history-service";
import { openingQueries } from "../../../../../../../features/opening/server/data-services";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const input = parseCourseLearningHistoryRequest((await context.params).id, new URL(request.url).searchParams);
    return Response.json(await openingQueries(sql).courseLearningHistory(scope, input));
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
