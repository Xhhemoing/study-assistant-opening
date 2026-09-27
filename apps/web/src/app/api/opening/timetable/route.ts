import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { getPlanService, requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const sessions = await getPlanService(sql).listTimetable(scope);
    return Response.json({ sessions });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const body = await readOpeningJsonBody(request);
    const sessions = Array.isArray(body)
      ? body
      : body !== null && typeof body === "object" && "sessions" in body
        ? body.sessions
        : undefined;
    const saved = await getPlanService(sql).saveTimetable(scope, sessions);
    return Response.json({ sessions: saved });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
