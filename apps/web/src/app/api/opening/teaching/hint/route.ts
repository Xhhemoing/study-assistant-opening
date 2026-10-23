import { teachingLoopApiDenied } from "../../../../../server/opening-config";
import { jsonError, mapDomainError } from "../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { createTeachingHintService } from "../../../../../features/opening/teaching/teaching-hint-service";
import { z } from "zod";

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const denied = teachingLoopApiDenied(scope.ownerUserId);
    if (denied) { denied.headers.set("Cache-Control", "no-store"); return denied; }
    const params = new URL(request.url).searchParams;
    const query = z.object({ attemptId: z.tuple([z.string().uuid()]) }).strict().parse(
      Object.fromEntries([...new Set(params.keys())].map(key => [key, params.getAll(key)])));
    return Response.json({ hints: await createTeachingHintService(sql).readReleased(scope, { attemptId: query.attemptId[0] }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { const response = jsonError(mapDomainError(error)); response.headers.set("Cache-Control", "no-store"); return response; }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const denied = teachingLoopApiDenied(scope.ownerUserId);
    if (denied) { denied.headers.set("Cache-Control", "no-store"); return denied; }
    return Response.json(await createTeachingHintService(sql).read(scope, await readOpeningJsonBody(request)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
