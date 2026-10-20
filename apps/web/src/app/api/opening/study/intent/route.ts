import { teachingLoopApiDenied } from "../../../../../server/opening-config";
import { z } from "zod";
import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { createStudyIntentService } from "../../../../../features/opening/teaching/span/intent-service";
export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const denied = teachingLoopApiDenied(scope.ownerUserId);
    if (denied) { denied.headers.set("Cache-Control", "no-store"); return denied; }
    const response = Response.json(await createStudyIntentService(sql).apply(scope, await readOpeningJsonBody(request)));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) { return jsonError(mapDomainError(error)); }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const denied = teachingLoopApiDenied(scope.ownerUserId);
    if (denied) { denied.headers.set("Cache-Control", "no-store"); return denied; }
    const sessionId = z.string().uuid().parse(new URL(request.url).searchParams.get("sessionId"));
    const response = Response.json({ event: await createStudyIntentService(sql).latest(scope, sessionId) });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) { return jsonError(mapDomainError(error)); }
}
