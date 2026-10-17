import { restoreBackupForPrincipal } from "../../../../features/library/backup-service";
import { jsonError, mapDomainError, requirePrincipal } from "../../../../features/auth/service";
import { getAuthRuntime } from "../../../../server/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";

export async function POST(request: Request): Promise<Response> {
  try {
    const runtime = getAuthRuntime();
    const principal = await requirePrincipal(runtime, request);
    const result = await restoreBackupForPrincipal(runtime, principal, await readOpeningJsonBody(request, 50 * 1024 * 1024));
    return Response.json(result);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
