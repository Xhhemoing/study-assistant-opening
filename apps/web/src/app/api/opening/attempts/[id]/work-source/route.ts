import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { getAttemptService, requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    return Response.json(await getAttemptService(sql).preparePhotoWorkSource(scope, id, await readOpeningJsonBody(request)), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) { return jsonError(mapDomainError(error)); }
}