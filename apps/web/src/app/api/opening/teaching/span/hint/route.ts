import { teachingLoopApiDenied } from "../../../../../../server/opening-config";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { createSpanHintService } from "../../../../../../features/opening/teaching/span/hint-service";
export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const denied = teachingLoopApiDenied(scope.ownerUserId);
    if (denied) { denied.headers.set("Cache-Control", "no-store"); return denied; }
    const response = Response.json(await createSpanHintService(sql).read(scope, await readOpeningJsonBody(request)));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) { return jsonError(mapDomainError(error)); }
}
