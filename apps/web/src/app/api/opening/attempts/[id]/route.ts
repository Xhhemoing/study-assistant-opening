import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { getAttemptService, requireOpeningScope } from "../../../../../features/opening/runtime";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    return Response.json(await getAttemptService(sql).get(scope, (await context.params).id));
  } catch (error) { return jsonError(mapDomainError(error)); }
}
