import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { getTeachingResumeService, requireOpeningScope } from "../../../../../../features/opening/runtime";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const summary = await getTeachingResumeService(sql).getSummary(scope, id);
    return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
