import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { getObservationService, requireOpeningScope } from "../../../../../../features/opening/runtime";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    return Response.json(await getObservationService(sql).observationHistory(scope, (await context.params).id));
  } catch (error) { return jsonError(mapDomainError(error)); }
}
