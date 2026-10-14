import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { planWithAgent } from "../../../../features/opening/planning/agent-service";
import { mapRepoError } from "../../../../features/opening/planning/plan-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const result = await planWithAgent(sql, scope, await readOpeningJsonBody(request, 8192), request.signal);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(mapRepoError(error))); }
}
