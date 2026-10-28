import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { createLongTermMaintenanceService } from "../../../../../../features/opening/planning/long-term-maintenance-service";
export async function POST(request: Request) {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    return Response.json(await createLongTermMaintenanceService(sql).start(scope, await readOpeningJsonBody(request)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
