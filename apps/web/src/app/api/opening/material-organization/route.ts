import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { openingQueries } from "../../../../features/opening/server/data-services";

export async function GET(request: Request): Promise<Response> {
  try {
    const { sql, scope } = await requireOpeningScope(request);
    return Response.json(await openingQueries(sql).materialOrganization(scope), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
