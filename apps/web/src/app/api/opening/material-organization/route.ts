import { readOpeningMaterialOrganization } from "@aistudy/database";
import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { requireOpeningScope } from "../../../../features/opening/runtime";

export async function GET(request: Request): Promise<Response> {
  try {
    const { sql, scope } = await requireOpeningScope(request);
    return Response.json(await readOpeningMaterialOrganization(sql, scope), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
