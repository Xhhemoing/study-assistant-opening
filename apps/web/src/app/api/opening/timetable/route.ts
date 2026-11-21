import { jsonError, mapDomainError } from "../../../../features/auth/service";
import { getPlanService, requireOpeningScope } from "../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../features/opening/request-body";

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const snapshot = await getPlanService(sql).timetableSnapshot(scope);
    return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
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
    const revision = body && typeof body === "object" && "expectedRevision" in body ? body.expectedRevision : undefined;
    const saved = await getPlanService(sql).saveTimetable(scope, sessions, revision);
    return Response.json({ sessions: saved });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
