import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { getAttemptService, requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request), { id } = await context.params;
    return Response.json(await getAttemptService(sql).submit(scope, id, await readOpeningJsonBody(request)), { status: 201 });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
