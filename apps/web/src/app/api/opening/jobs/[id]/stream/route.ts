import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { getTutorJobService } from "../../../../../../features/opening/server/data-services";
import { openTutorJobStream } from "../../../../../../features/opening/server/job-stream";

type Params = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Params): Promise<Response> {
  try {
    const { scope, sql } = await requireOpeningScope(request);
    const { id } = await context.params;
    const job = await getTutorJobService(sql).get(scope, id);
    if (!job) return Response.json({ error: { code: "NOT_FOUND", message: "job not found" } }, { status: 404 });
    return await openTutorJobStream(sql, scope, job, request.signal);
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
