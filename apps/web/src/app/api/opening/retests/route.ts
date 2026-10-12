import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { openingQueries } from "../../../../features/opening/server/data-services";
export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    return Response.json(await openingQueries(sql).retestReviewCandidates(scope));
  } catch (error) { return jsonError(mapDomainError(error)); }
}
