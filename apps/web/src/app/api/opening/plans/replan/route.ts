import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { getPlanService, requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    return Response.json(await getPlanService(sql).proposeLocalReplan(scope, await readOpeningJsonBody(request)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
