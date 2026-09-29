import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { getObservationService, requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const result = await getObservationService(sql).reviseObservation(scope, await readOpeningJsonBody(request));
    return Response.json(result, { status: result.disposition === "applied" ? 201 : 200 });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
