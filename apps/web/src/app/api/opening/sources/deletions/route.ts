import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { createOpeningSourceService } from "../../../../../features/opening/sources/source-service";

export async function GET(request: Request): Promise<Response> {
  try {
    const { principal, sql } = await requireOpeningScope(request);
    return Response.json(await createOpeningSourceService(sql).listSourceDeletions(principal));
  } catch (error) { return jsonError(mapDomainError(error)); }
}
