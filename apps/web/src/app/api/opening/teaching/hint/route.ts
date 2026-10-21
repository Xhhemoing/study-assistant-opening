import { teachingLoopApiDenied } from "../../../../../server/opening-config";
import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { createTeachingHintService } from "../../../../../features/opening/teaching/teaching-hint-service";

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const denied = teachingLoopApiDenied(scope.ownerUserId);
    if (denied) { denied.headers.set("Cache-Control", "no-store"); return denied; }
    return Response.json(await createTeachingHintService(sql).read(scope, await readOpeningJsonBody(request)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
