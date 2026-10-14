import { getOpeningGuidanceSettings, saveOpeningGuidanceSettings } from "../../../../features/opening/server/workspace-setup-service";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";
import { mapRepoError } from "../../../../features/opening/planning/plan-service";
export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    return Response.json({ settings: await getOpeningGuidanceSettings(sql, scope), automaticReorderingActive: false }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(mapRepoError(error))); }
}
export async function PUT(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    return Response.json({ settings: await saveOpeningGuidanceSettings(sql, scope, await readOpeningJsonBody(request, 4096)), automaticReorderingActive: false }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(mapRepoError(error))); }
}
