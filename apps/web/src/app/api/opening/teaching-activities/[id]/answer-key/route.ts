import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { getTeachingContentService, requireOpeningScope } from "../../../../../../features/opening/runtime";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const query = new URL(request.url).searchParams;
    const result = await getTeachingContentService(sql).getSubmittedAnswerKey(scope, id, query.get("blockId"), query.get("attemptId"));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
