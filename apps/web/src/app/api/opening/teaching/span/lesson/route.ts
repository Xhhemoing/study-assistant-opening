import { z } from "zod";
import { teachingLoopApiDenied } from "../../../../../../server/opening-config";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { createSpanLessonSessionService } from "../../../../../../features/opening/teaching/span/lesson-session-service";

async function respond(request: Request, method: "GET" | "POST" | "PATCH"): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const denied = teachingLoopApiDenied(scope.ownerUserId);
    if (denied) { denied.headers.set("Cache-Control", "no-store"); return denied; }
    const service = createSpanLessonSessionService(sql);
    const url = new URL(request.url);
    const result = method === "GET"
      ? await service.read(scope, url.searchParams.get("courseId") ?? "", url.searchParams.get("activityId"), url.searchParams.get("retestId"))
      : method === "POST" ? await service.create(scope, await readOpeningJsonBody(request))
        : await service.save(scope, z.string().uuid().parse(url.searchParams.get("activityId")), await readOpeningJsonBody(request));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(mapDomainError(error)); }
}
export const GET = (request: Request) => respond(request, "GET");
export const POST = (request: Request) => respond(request, "POST");
export const PATCH = (request: Request) => respond(request, "PATCH");
