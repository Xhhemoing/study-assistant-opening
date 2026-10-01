import { readOpeningCourseLearningHistory } from "@aistudy/database";
import { jsonError, mapDomainError } from "../../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../../features/opening/runtime";
import { parseCourseLearningHistoryRequest } from "../../../../../../../features/opening/learning/history-service";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const input = parseCourseLearningHistoryRequest((await context.params).id, new URL(request.url).searchParams);
    return Response.json(await readOpeningCourseLearningHistory(sql, scope, input));
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
